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

  // Regression: an autoplay-policy rejection on resume must revert to
  // 'paused' rather than stranding the player claiming 'playing' while no
  // audio is actually running.
  it('reverts to paused when resume() is rejected', async () => {
    const harness = makePlayer();
    const { player, driver, events, eventNames } = harness;
    await playing(harness);
    player.pause();
    driver.playRejection = new Error('NotAllowedError');

    player.resume();
    await settle();

    expect(player.status()).toBe('paused');
    // The play itself was fine — an autoplay rejection is not a load
    // failure — so it must survive intact for a later gesture to retry.
    expect(player.activeSong()).not.toBeNull();

    const before = events.filter((e) => e.name === 'play-elapsed').length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(events.filter((e) => e.name === 'play-elapsed')).toHaveLength(before);

    expect(events.filter((e) => e.name === 'error')).toHaveLength(1);
    // status() and the event stream must agree: a consumer watching only
    // events, not polling status(), still needs to see the revert.
    expect(eventNames().at(-1)).toBe('play-paused');

    const playsBefore = driver.playCalls;
    player.resume();
    await settle();

    expect(player.status()).toBe('playing');
    expect(driver.playCalls).toBe(playsBefore + 1);
  });

  // Regression: #advance() (ended/skip) moves to a new song without
  // bumping #generation, so "same generation" alone does not mean "same
  // song". A resume() rejection that lands after #advance() has already
  // moved on must not stomp on the song that is genuinely playing now.
  it('does not revert a resume() rejection that arrives after the song has moved on', async () => {
    const harness = makePlayer();
    const { player, driver, events, eventNames } = harness;
    await playing(harness); // 'p1' active, 'p2' already reserved as standby
    player.pause();

    let rejectResume: (() => void) | undefined;
    let calls = 0;
    driver.play = vi.fn(() => {
      calls += 1;
      // Only resume()'s own call (the first) stays pending; anything
      // #advance() triggers afterward should succeed normally.
      if (calls === 1) {
        return new Promise<void>((_resolve, reject) => { rejectResume = () => reject(new Error('AbortError')); });
      }
      return Promise.resolve();
    });

    player.resume(); // driver.play() call #1 is now pending
    driver.markStandbyReady();
    driver.fire('ended'); // #advance() promotes standby to 'p2' and calls driver.play() #2, which resolves
    await settle();

    expect(player.status()).toBe('playing');
    expect(player.activeSong()).toMatchObject({ title: 'Song p2' });
    const eventsSoFar = events.length;

    // The stale rejection from resume()'s original, superseded call arrives now.
    rejectResume?.();
    await settle();

    expect(player.status()).toBe('playing');
    expect(player.activeSong()).toMatchObject({ title: 'Song p2' });
    expect(events.filter((e) => e.name === 'error')).toHaveLength(0);
    expect(eventNames().slice(eventsSoFar)).not.toContain('play-paused');
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

  // Regression: a granted skip while paused must leave status() reporting
  // 'playing', not stranded at 'paused' while audio is audibly advancing.
  it('status reflects playing after a granted skip while paused', async () => {
    const harness = makePlayer();
    const { player, driver } = harness;
    await playing(harness);
    player.pause();

    await player.skip();
    driver.fire('playing');

    expect(player.status()).toBe('playing');
  });
});
