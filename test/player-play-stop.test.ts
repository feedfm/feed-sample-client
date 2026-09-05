import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makePlay, makePlayer, makeSearchPlay, apiStation } from './player-harness.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** Drives the fake driver through the events a real element would emit. */
async function beginPlayback(driver: { fire: (e: 'playing') => void }) {
  await vi.advanceTimersByTimeAsync(0);
  driver.fire('playing');
  await vi.advanceTimersByTimeAsync(0);
}

describe('play', () => {
  it('goes to playing and buffering immediately, before any network work', () => {
    const { player, client, driver } = makePlayer();
    client.createPlay.mockResolvedValue(makePlay('p1'));

    player.play({ uuid: 'u-7', name: 'Pop', options: {} });

    expect(player.status()).toBe('playing');
    expect(player.buffering()).toBe(true);
    expect(driver.unlockCalls).toBe(1);
  });

  it('uses the play reserved by findStation instead of a new POST /play', async () => {
    const { player, client, driver } = makePlayer();
    client.searchStation.mockResolvedValue(makeSearchPlay('search-1'));
    const station = (await player.findStation('Pop'))!;

    player.play(station);
    await beginPlayback(driver);

    expect(client.createPlay).toHaveBeenCalledTimes(1); // the next-song preload only
    expect(driver.currentUrl).toBe('https://cdn/search-1.mp3');
  });

  it('reserves a play by station id when it has no fresh reservation', async () => {
    const { player, client, driver } = makePlayer();
    client.createPlay.mockResolvedValue(makePlay('p1'));

    player.play({ uuid: 'u-7', name: 'Pop', options: {} });
    await beginPlayback(driver);

    expect(client.createPlay).toHaveBeenCalledWith('7');
    expect(driver.currentUrl).toBe('https://cdn/p1.mp3');
  });

  it('locates a station by uuid when it holds no internal record', async () => {
    const { player, client, driver } = makePlayer([]);
    client.searchStation.mockResolvedValue(makeSearchPlay('p1', apiStation({ uuid: 'u-x', id: '99' })));
    client.createPlay.mockResolvedValue(makePlay('p2'));

    player.play({ uuid: 'u-x', name: 'Elsewhere', options: {} });
    await beginPlayback(driver);

    expect(client.searchStation).toHaveBeenCalledWith({ filter: { uuid: 'u-x' } });
  });

  it('reports the start and clears buffering once audio really plays', async () => {
    const { player, client, driver, eventNames } = makePlayer();
    client.createPlay.mockResolvedValue(makePlay('p1'));

    player.play({ uuid: 'u-7', name: 'Pop', options: {} });
    await beginPlayback(driver);

    expect(client.startPlay).toHaveBeenCalledWith('p1');
    expect(player.buffering()).toBe(false);
    expect(eventNames()).toEqual(['buffering-started', 'buffering-ended', 'play-started']);
    expect(player.activeSong()).toMatchObject({ title: 'Song p1', artist: 'Artist', release: 'Album' });
  });

  it('preloads the next song right after reporting the start', async () => {
    const { player, client, driver } = makePlayer();
    client.createPlay.mockResolvedValueOnce(makePlay('p1')).mockResolvedValueOnce(makePlay('p2'));

    player.play({ uuid: 'u-7', name: 'Pop', options: {} });
    await beginPlayback(driver);

    expect(driver.standbyUrl).toBe('https://cdn/p2.mp3');
  });

  it('emits play-elapsed every second while playing', async () => {
    const { player, client, driver, events } = makePlayer();
    client.createPlay.mockResolvedValue(makePlay('p1'));

    player.play({ uuid: 'u-7', name: 'Pop', options: {} });
    await beginPlayback(driver);
    await vi.advanceTimersByTimeAsync(3000);

    expect(events.filter((e) => e.name === 'play-elapsed')).toHaveLength(3);
  });

  it('reports elapsed time to the server every ten seconds', async () => {
    const { player, client, driver } = makePlayer();
    client.createPlay.mockResolvedValue(makePlay('p1'));

    player.play({ uuid: 'u-7', name: 'Pop', options: {} });
    await beginPlayback(driver);
    driver.setCurrentTime(10);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(client.elapsePlay).toHaveBeenCalledWith('p1', 10);
  });

  it('is a no-op when asked to play the station already playing', async () => {
    const { player, client, driver } = makePlayer();
    client.createPlay.mockResolvedValue(makePlay('p1'));
    const station = { uuid: 'u-7', name: 'Pop', options: {} };

    player.play(station);
    await beginPlayback(driver);
    const callsBefore = client.createPlay.mock.calls.length;

    player.play(station);
    await vi.advanceTimersByTimeAsync(0);

    expect(client.createPlay.mock.calls.length).toBe(callsBefore);
  });
});

describe('stop', () => {
  it('reports elapsed, stops audio, and clears state', async () => {
    const { player, client, driver, eventNames } = makePlayer();
    client.createPlay.mockResolvedValue(makePlay('p1'));

    player.play({ uuid: 'u-7', name: 'Pop', options: {} });
    await beginPlayback(driver);
    driver.setCurrentTime(42);
    player.stop();

    expect(client.elapsePlay).toHaveBeenCalledWith('p1', 42);
    expect(driver.stopCalls).toBe(1);
    expect(player.status()).toBe('stopped');
    expect(player.activeSong()).toBeNull();
    expect(eventNames().at(-1)).toBe('play-stopped');
  });

  // An unused play is discarded. Only a bad load ever invalidates.
  it('discards the preloaded next play without invalidating it', async () => {
    const { player, client, driver } = makePlayer();
    client.createPlay.mockResolvedValueOnce(makePlay('p1')).mockResolvedValueOnce(makePlay('p2'));

    player.play({ uuid: 'u-7', name: 'Pop', options: {} });
    await beginPlayback(driver);
    player.stop();

    expect(client.invalidatePlay).not.toHaveBeenCalled();
  });

  it('never completes a song the listener did not finish', async () => {
    const { player, client, driver } = makePlayer();
    client.createPlay.mockResolvedValue(makePlay('p1'));

    player.play({ uuid: 'u-7', name: 'Pop', options: {} });
    await beginPlayback(driver);
    player.stop();

    expect(client.completePlay).not.toHaveBeenCalled();
  });

  it('is a no-op when already stopped', () => {
    const { player, driver, eventNames } = makePlayer();
    player.stop();
    expect(driver.stopCalls).toBe(0);
    expect(eventNames()).toEqual([]);
  });

  it('stops the elapsed timers', async () => {
    const { player, client, driver, events } = makePlayer();
    client.createPlay.mockResolvedValue(makePlay('p1'));

    player.play({ uuid: 'u-7', name: 'Pop', options: {} });
    await beginPlayback(driver);
    player.stop();
    const before = events.filter((e) => e.name === 'play-elapsed').length;
    await vi.advanceTimersByTimeAsync(5000);

    expect(events.filter((e) => e.name === 'play-elapsed')).toHaveLength(before);
  });
});
