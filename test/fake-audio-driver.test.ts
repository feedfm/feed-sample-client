import { describe, expect, it, vi } from 'vitest';
import { FakeAudioDriver } from './fake-audio-driver.js';

describe('FakeAudioDriver', () => {
  it('records loads and playback calls', async () => {
    const driver = new FakeAudioDriver();
    driver.loadCurrent('https://cdn/a.mp3', 12);
    await driver.play();

    expect(driver.currentUrl).toBe('https://cdn/a.mp3');
    expect(driver.currentTime()).toBe(12);
    expect(driver.playCalls).toBe(1);
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
