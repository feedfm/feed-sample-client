import { describe, expect, it, vi } from 'vitest';
import { FakeAudioDriver } from './fake-audio-driver.js';

describe('FakeAudioDriver', () => {
  // A real play() promise settles when playback begins, not when play() is
  // called, so the fake keeps it pending until `playing` fires.
  it('records loads and settles play() once playback begins', async () => {
    const driver = new FakeAudioDriver();
    driver.loadCurrent('https://cdn/a.mp3', 12);
    const started = driver.play();
    expect(driver.hasPendingPlay()).toBe(true);

    driver.fire('playing');
    await expect(started).resolves.toBeUndefined();

    expect(driver.currentUrl).toBe('https://cdn/a.mp3');
    expect(driver.currentTime()).toBe(12);
    expect(driver.playCalls).toBe(1);
  });

  // The behaviour the real element couples and the fake used to hide:
  // pause() rejects every play() promise still waiting on a load.
  it('rejects a pending play() with AbortError when paused', async () => {
    const driver = new FakeAudioDriver();
    driver.loadCurrent('https://cdn/a.mp3');
    const started = driver.play();

    driver.pause();

    await expect(started).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects a pending play() when stopped or when a new source is loaded', async () => {
    const stopped = new FakeAudioDriver();
    const stoppedPlay = stopped.play();
    stopped.stop();
    await expect(stoppedPlay).rejects.toMatchObject({ name: 'AbortError' });

    const reloaded = new FakeAudioDriver();
    const reloadedPlay = reloaded.play();
    reloaded.loadCurrent('https://cdn/b.mp3');
    await expect(reloadedPlay).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects a pending play() when the element errors', async () => {
    const driver = new FakeAudioDriver();
    driver.loadCurrent('https://cdn/broken.mp3');
    const started = driver.play();

    driver.fire('error');

    await expect(started).rejects.toMatchObject({ name: 'NotSupportedError' });
  });

  it('reports no standby until it is marked ready', () => {
    const driver = new FakeAudioDriver();
    driver.loadStandby('https://cdn/b.mp3');
    expect(driver.hasStandby()).toBe(false);

    driver.markStandbyReady();
    expect(driver.hasStandby()).toBe(true);
  });

  it('promotes standby into current and clears it', () => {
    const driver = new FakeAudioDriver();
    driver.loadCurrent('https://cdn/a.mp3');
    driver.loadStandby('https://cdn/b.mp3');
    driver.markStandbyReady();

    driver.promoteStandby();

    expect(driver.currentUrl).toBe('https://cdn/b.mp3');
    expect(driver.hasStandby()).toBe(false);
  });

  it('delivers fired events to registered handlers', () => {
    const driver = new FakeAudioDriver();
    const onEnded = vi.fn();
    driver.on('ended', onEnded);

    driver.fire('ended');

    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('resets position and urls on stop', () => {
    const driver = new FakeAudioDriver();
    driver.loadCurrent('https://cdn/a.mp3');
    driver.setCurrentTime(30);

    driver.stop();

    expect(driver.currentUrl).toBeUndefined();
    expect(driver.currentTime()).toBe(0);
    expect(driver.stopCalls).toBe(1);
  });
});
