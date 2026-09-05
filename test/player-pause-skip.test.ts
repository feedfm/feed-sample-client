import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedError } from '../src/errors.js';
import { makePlay, makePlayer } from './player-harness.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function settle() { await vi.advanceTimersByTimeAsync(0); }

async function playing(harness: ReturnType<typeof makePlayer>) {
  harness.client.createPlay.mockResolvedValueOnce(makePlay('p1')).mockResolvedValue(makePlay('p2'));
  harness.player.play({ uuid: 'u-7', name: 'Pop', options: {} });
  await settle();
  harness.driver.fire('playing');
  await settle();
}

describe('pause and resume', () => {
  it('pauses audio, reports elapsed, and emits play-paused', async () => {
    const harness = makePlayer();
    const { player, client, driver, eventNames } = harness;
    await playing(harness);
    driver.setCurrentTime(25);

    player.pause();

    expect(player.status()).toBe('paused');
    expect(driver.pauseCalls).toBe(1);
    expect(client.elapsePlay).toHaveBeenCalledWith('p1', 25);
    expect(eventNames().at(-1)).toBe('play-paused');
  });

  it('keeps the active song while paused', async () => {
    const harness = makePlayer();
    await playing(harness);
    harness.player.pause();

    expect(harness.player.activeSong()).toMatchObject({ title: 'Song p1' });
  });

  it('stops the elapsed ticks while paused', async () => {
    const harness = makePlayer();
    const { player, events } = harness;
    await playing(harness);
    player.pause();
    const before = events.filter((e) => e.name === 'play-elapsed').length;

    await vi.advanceTimersByTimeAsync(5000);

    expect(events.filter((e) => e.name === 'play-elapsed')).toHaveLength(before);
  });

  it('resume restarts audio and emits play-started', async () => {
    const harness = makePlayer();
    const { player, driver, eventNames } = harness;
    await playing(harness);
    const playsBefore = driver.playCalls;
    player.pause();

    player.resume();
    await settle();

    expect(player.status()).toBe('playing');
    expect(driver.playCalls).toBe(playsBefore + 1);
    expect(eventNames().at(-1)).toBe('play-started');
  });

  it('play() on the paused station resumes rather than restarting', async () => {
    const harness = makePlayer();
    const { player, client, driver } = harness;
    await playing(harness);
    player.pause();
    const callsBefore = client.createPlay.mock.calls.length;

    player.play({ uuid: 'u-7', name: 'Pop', options: {} });
    await settle();

    expect(player.status()).toBe('playing');
    expect(client.createPlay.mock.calls.length).toBe(callsBefore);
    expect(driver.currentUrl).toBe('https://cdn/p1.mp3');
  });

  it('resume does nothing after stop', async () => {
    const harness = makePlayer();
    const { player } = harness;
    await playing(harness);
    player.stop();

    player.resume();

    expect(player.status()).toBe('stopped');
    expect(player.activeSong()).toBeNull();
  });

  it('pause does nothing when not playing', () => {
    const { player, driver } = makePlayer();
    player.pause();
    expect(driver.pauseCalls).toBe(0);
  });
});

describe('skip', () => {
  it('asks the server with the elapsed position and advances when granted', async () => {
    const harness = makePlayer();
    const { player, client, driver } = harness;
    await playing(harness);
    driver.setCurrentTime(18);
    driver.markStandbyReady();

    await expect(player.skip()).resolves.toBe(true);

    expect(client.skipPlay).toHaveBeenCalledWith('p1', 18);
    expect(driver.currentUrl).toBe('https://cdn/p2.mp3');
  });

  // The skip already closed the play out; completing it too would be a lie.
  it('does not complete the skipped play', async () => {
    const harness = makePlayer();
    const { player, client, driver } = harness;
    await playing(harness);
    driver.markStandbyReady();

    await player.skip();

    expect(client.completePlay).not.toHaveBeenCalled();
  });

  // Licensing: stopping a song without a granted skip can get credentials revoked.
  it('keeps playing the current song when the skip is denied', async () => {
    const harness = makePlayer();
    const { player, client, driver } = harness;
    await playing(harness);
    client.skipPlay.mockResolvedValue(false);

    await expect(player.skip()).resolves.toBe(false);

    expect(driver.currentUrl).toBe('https://cdn/p1.mp3');
    expect(player.status()).toBe('playing');
    expect(player.activeSong()).toMatchObject({ title: 'Song p1' });
  });

  it('emits no error for a denied skip', async () => {
    const harness = makePlayer();
    const { player, client, events } = harness;
    await playing(harness);
    client.skipPlay.mockResolvedValue(false);

    await player.skip();

    expect(events.filter((e) => e.name === 'error')).toHaveLength(0);
  });

  it('resolves false and emits error when the skip request itself fails', async () => {
    const harness = makePlayer();
    const { player, client, events } = harness;
    await playing(harness);
    client.skipPlay.mockRejectedValue(new FeedError(22, 'throttled', 429));

    await expect(player.skip()).resolves.toBe(false);
    expect(events.filter((e) => e.name === 'error')).toHaveLength(1);
  });

  it('resolves false when nothing is playing', async () => {
    const { player, client } = makePlayer();
    await expect(player.skip()).resolves.toBe(false);
    expect(client.skipPlay).not.toHaveBeenCalled();
  });
});
