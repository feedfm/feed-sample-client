import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedError } from '../src/errors.js';
import { makePlay, makePlayer } from './player-harness.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function settle() { await vi.advanceTimersByTimeAsync(0); }

async function playFirstSong(harness: ReturnType<typeof makePlayer>) {
  harness.player.play({ uuid: 'u-7', name: 'Pop', options: {} });
  await settle();
  harness.driver.fire('playing');
  await settle();
}

describe('advancing when a song ends', () => {
  it('completes the finished play and promotes the preloaded next one', async () => {
    const harness = makePlayer();
    const { player, client, driver } = harness;
    client.createPlay.mockResolvedValueOnce(makePlay('p1')).mockResolvedValueOnce(makePlay('p2'));

    await playFirstSong(harness);
    driver.markStandbyReady();
    driver.fire('ended');
    await settle();

    expect(client.completePlay).toHaveBeenCalledWith('p1');
    expect(driver.currentUrl).toBe('https://cdn/p2.mp3');
    expect(player.status()).toBe('playing');
  });

  it('reports the start of the promoted song and preloads another', async () => {
    const harness = makePlayer();
    const { client, driver, eventNames } = harness;
    client.createPlay
      .mockResolvedValueOnce(makePlay('p1'))
      .mockResolvedValueOnce(makePlay('p2'))
      .mockResolvedValueOnce(makePlay('p3'));

    await playFirstSong(harness);
    driver.markStandbyReady();
    driver.fire('ended');
    await settle();
    driver.fire('playing');
    await settle();

    expect(client.startPlay).toHaveBeenCalledWith('p2');
    expect(driver.standbyUrl).toBe('https://cdn/p3.mp3');
    expect(eventNames().filter((n) => n === 'play-started')).toHaveLength(2);
  });

  // A ready standby means no network wait, so there is nothing to report.
  it('does not emit buffering when the next song is already loaded', async () => {
    const harness = makePlayer();
    const { client, driver, eventNames } = harness;
    client.createPlay.mockResolvedValueOnce(makePlay('p1')).mockResolvedValue(makePlay('p2'));

    await playFirstSong(harness);
    const before = eventNames().length;
    driver.markStandbyReady();
    driver.fire('ended');
    await settle();

    expect(eventNames().slice(before)).not.toContain('buffering-started');
  });

  it('buffers and fetches when the standby has not loaded in time', async () => {
    const harness = makePlayer();
    const { player, client, driver, eventNames } = harness;
    client.createPlay.mockResolvedValueOnce(makePlay('p1')).mockResolvedValue(makePlay('p9'));

    await playFirstSong(harness);
    driver.fire('ended'); // standby never marked ready
    await settle();

    expect(player.buffering()).toBe(true);
    expect(eventNames()).toContain('buffering-started');
    expect(driver.currentUrl).toBe('https://cdn/p9.mp3');
  });
});

describe('running out of music', () => {
  it('stops cleanly with reason ended and emits no error', async () => {
    const harness = makePlayer();
    const { player, client, driver, events } = harness;
    client.createPlay
      .mockResolvedValueOnce(makePlay('p1'))
      .mockRejectedValue(new FeedError(9, 'no more music', 200));

    await playFirstSong(harness);
    driver.fire('ended');
    await settle();

    expect(player.status()).toBe('stopped');
    expect(events.filter((e) => e.name === 'error')).toHaveLength(0);
    expect(events.at(-1)).toEqual({ name: 'play-stopped', arg: { reason: 'ended' } });
  });

  it('still completes the song that finished', async () => {
    const harness = makePlayer();
    const { client, driver } = harness;
    client.createPlay
      .mockResolvedValueOnce(makePlay('p1'))
      .mockRejectedValue(new FeedError(9, 'no more music', 200));

    await playFirstSong(harness);
    driver.fire('ended');
    await settle();

    expect(client.completePlay).toHaveBeenCalledWith('p1');
    // The play was already completed; teardown must not also elapse it.
    expect(client.elapsePlay).not.toHaveBeenCalled();
  });
});

describe('a reserve racing an advance', () => {
  // POST /play returns the same play until one is started or invalidated, so a
  // reserve still in flight when a song ends can hand #advance's own fetch the
  // identical play. If both slots keep it, the song is promoted a second time -
  // starting and completing one play id twice, a double-reported listen.
  it('never holds one play as both the active and the next song', async () => {
    const harness = makePlayer();
    const { client, driver } = harness;
    const playB = makePlay('pB');

    let resolveReserve!: (play: ReturnType<typeof makePlay>) => void;
    let resolveAdvance!: (play: ReturnType<typeof makePlay>) => void;

    client.createPlay
      .mockResolvedValueOnce(makePlay('pA'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveReserve = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveAdvance = resolve; }));

    await playFirstSong(harness);        // pA playing; the reserve is still in flight
    driver.fire('ended');                // no nextPlay, no standby -> advance fetches its own
    await settle();

    resolveReserve(playB);               // the reserve lands first, while activePlay is null
    await settle();
    resolveAdvance(playB);               // advance's fetch returns the very same play
    await settle();

    driver.fire('playing');              // pB starts
    await settle();
    driver.markStandbyReady();
    driver.fire('ended');                // would promote the duplicate pB
    await settle();
    driver.fire('playing');
    await settle();

    const started = client.startPlay.mock.calls.map((call) => call[0]);
    expect(started).toEqual([...new Set(started)]);
  });
});
