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
  });
});
