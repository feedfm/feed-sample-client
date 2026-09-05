import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Play } from '../src/api/schema.js';
import { NOW, makePlay, makePlayer } from './player-harness.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function settle() { await vi.advanceTimersByTimeAsync(0); }

const expiredUrl = `https://cdn/old.mp3?Expires=${NOW / 1000 - 60}&Signature=s`;
const validUrl = `https://cdn/good.mp3?Expires=${NOW / 1000 + 600}&Signature=s`;

const POP = { uuid: 'u-7', name: 'Pop', options: {} };

describe('expired audio URLs', () => {
  // An expired signature does not mean a bad song. POST /play re-signs it.
  it('re-fetches without invalidating when the URL has expired', async () => {
    const { player, client, driver } = makePlayer();
    client.createPlay
      .mockResolvedValueOnce(makePlay('p1', expiredUrl))
      .mockResolvedValue(makePlay('p1', validUrl));
    driver.playRejection = new Error('load failed');

    player.play(POP);
    await settle();

    expect(client.invalidatePlay).not.toHaveBeenCalled();
    expect(driver.currentUrl).toBe(validUrl);
  });

  // FakeAudioDriver#play() clears playRejection after it throws once, so a
  // rejection armed only before the initial attempt would let the very first
  // retry succeed and never touch the cap. Re-arming it inside the
  // createPlay mock ensures every attempt in the cascade genuinely fails,
  // so this test actually drives the counter into MAX_EXPIRY_REFETCHES
  // rather than passing by surviving on a single retry.
  it('gives up re-fetching after MAX_EXPIRY_REFETCHES', async () => {
    const { player, client, driver, events } = makePlayer();
    client.createPlay.mockImplementation(async () => {
      driver.playRejection = new Error('load failed');
      return makePlay('p1', expiredUrl);
    });

    player.play(POP);
    await settle();

    expect(client.createPlay).toHaveBeenCalledTimes(1 + 2); // initial + MAX_EXPIRY_REFETCHES
    expect(player.status()).toBe('stopped');
    expect(events.filter((e) => e.name === 'error').length).toBeGreaterThan(0);
  });

  it('discards a reservation whose URL expired and fetches a fresh play', async () => {
    const { player, client, driver } = makePlayer();
    client.searchStation.mockResolvedValue({
      ...makePlay('search-1', expiredUrl),
      station: { id: '7', uuid: 'u-7', name: 'Pop', on_demand: 0, pre_gain: null, options: {}, crossfade_seconds: 0, single_play: 0, last_updated: 'x' },
    });
    client.createPlay.mockResolvedValue(makePlay('fresh', validUrl));

    const station = (await player.findStation('Pop'))!;
    player.play(station);
    await settle();

    expect(client.invalidatePlay).not.toHaveBeenCalled();
    expect(client.createPlay).toHaveBeenCalledWith('7');
    expect(driver.currentUrl).toBe(validUrl);
  });
});

describe('genuinely bad audio', () => {
  // Without invalidate, POST /play hands back the same broken play forever.
  it('invalidates a play whose URL is still valid but will not load', async () => {
    const { player, client, driver } = makePlayer();
    client.createPlay
      .mockResolvedValueOnce(makePlay('bad', validUrl))
      .mockResolvedValue(makePlay('good', validUrl));
    driver.playRejection = new Error('decode error');

    player.play(POP);
    await settle();

    expect(client.invalidatePlay).toHaveBeenCalledWith('bad', expect.any(String));
    expect(driver.currentUrl).toBe(validUrl);
  });

  it('invalidates when the URL carries no Expires at all', async () => {
    const { player, client, driver } = makePlayer();
    client.createPlay
      .mockResolvedValueOnce(makePlay('bad', 'https://cdn/bad.mp3'))
      .mockResolvedValue(makePlay('good', 'https://cdn/good.mp3'));
    driver.playRejection = new Error('decode error');

    player.play(POP);
    await settle();

    expect(client.invalidatePlay).toHaveBeenCalledWith('bad', expect.any(String));
  });

  // Same reasoning as the expiry cap above: re-arm the rejection on every
  // createPlay call so each attempt in the retry cascade genuinely fails,
  // driving consecutiveFailures to MAX_CONSECUTIVE_PLAY_FAILURES instead of
  // succeeding on the first retry and leaving the cap unexercised.
  it('stops with an error after three consecutive failures', async () => {
    const { player, client, driver, events } = makePlayer();
    client.createPlay.mockImplementation(async () => {
      driver.playRejection = new Error('decode error');
      return makePlay('bad', validUrl);
    });

    player.play(POP);
    await settle();

    expect(client.createPlay).toHaveBeenCalledTimes(3); // MAX_CONSECUTIVE_PLAY_FAILURES
    expect(client.invalidatePlay).toHaveBeenCalledTimes(3);
    expect(player.status()).toBe('stopped');
    expect(events.filter((e) => e.name === 'error')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ name: 'play-stopped', arg: { reason: 'error' } });
  });

  it('surfaces a driver error event as a load failure', async () => {
    const { player, client, driver } = makePlayer();
    client.createPlay
      .mockResolvedValueOnce(makePlay('bad', validUrl))
      .mockResolvedValue(makePlay('good', validUrl));

    player.play(POP);
    await settle();
    driver.fire('error');
    await settle();

    expect(client.invalidatePlay).toHaveBeenCalledWith('bad', expect.any(String));
  });
});

describe('single stream guarantee', () => {
  it('drops a late response from a superseded play()', async () => {
    const { player, client, driver } = makePlayer([
      { uuid: 'u-7', id: '7', name: 'Pop', options: {} },
      { uuid: 'u-8', id: '8', name: 'Rock', options: {} },
    ]);

    let releaseSlow: (play: Play) => void = () => {};
    client.createPlay
      .mockImplementationOnce(() => new Promise((resolve) => { releaseSlow = resolve; }))
      .mockResolvedValue(makePlay('rock-1'));

    player.play(POP);
    player.play({ uuid: 'u-8', name: 'Rock', options: {} });
    await settle();

    releaseSlow(makePlay('pop-1'));
    await settle();

    expect(driver.currentUrl).toBe('https://cdn/rock-1.mp3');
  });

  it('reports elapsed and emits superseded when switching stations mid-song', async () => {
    const harness = makePlayer([
      { uuid: 'u-7', id: '7', name: 'Pop', options: {} },
      { uuid: 'u-8', id: '8', name: 'Rock', options: {} },
    ]);
    const { player, client, driver, eventNames } = harness;
    client.createPlay.mockResolvedValue(makePlay('p1'));

    player.play(POP);
    await settle();
    driver.fire('playing');
    await settle();
    driver.setCurrentTime(33);

    player.play({ uuid: 'u-8', name: 'Rock', options: {} });
    await settle();

    expect(client.elapsePlay).toHaveBeenCalledWith('p1', 33);
    expect(client.invalidatePlay).not.toHaveBeenCalled();
    expect(eventNames()).toContain('play-stopped');
  });

  it('never completes the outgoing song when switching stations', async () => {
    const harness = makePlayer([
      { uuid: 'u-7', id: '7', name: 'Pop', options: {} },
      { uuid: 'u-8', id: '8', name: 'Rock', options: {} },
    ]);
    const { player, client, driver } = harness;
    client.createPlay.mockResolvedValue(makePlay('p1'));

    player.play(POP);
    await settle();
    driver.fire('playing');
    await settle();
    player.play({ uuid: 'u-8', name: 'Rock', options: {} });
    await settle();

    expect(client.completePlay).not.toHaveBeenCalled();
  });
});
