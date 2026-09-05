import { describe, expect, it, vi } from 'vitest';
import { HtmlAudioDriver } from '../src/audio/html-audio.js';

class FakeElement {
  src = '';
  preload = '';
  currentTime = 0;
  readyState = 0;
  paused = true;
  play = vi.fn(async () => { this.paused = false; });
  pause = vi.fn(() => { this.paused = true; });
  load = vi.fn();
  removeAttribute = vi.fn(() => { this.src = ''; });
  readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, handler: () => void): void {
    let set = this.listeners.get(type);
    if (set === undefined) { set = new Set(); this.listeners.set(type, set); }
    set.add(handler);
  }

  dispatch(type: string): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler();
  }
}

function makeDriver() {
  const elements: FakeElement[] = [];
  const driver = new HtmlAudioDriver({
    createElement: () => {
      const element = new FakeElement();
      elements.push(element);
      return element as unknown as HTMLAudioElement;
    },
  });
  return { driver, current: elements[0]!, standby: elements[1]! };
}

describe('HtmlAudioDriver', () => {
  it('creates two elements so the next song can preload', () => {
    const { current, standby } = makeDriver();
    expect(current).toBeDefined();
    expect(standby).toBeDefined();
  });

  it('loads a url into the current element and applies startAt', () => {
    const { driver, current } = makeDriver();
    driver.loadCurrent('https://cdn/a.mp3', 30);

    expect(current.src).toBe('https://cdn/a.mp3');
    current.dispatch('loadedmetadata');
    expect(current.currentTime).toBe(30);
  });

  it('preloads into the standby element', () => {
    const { driver, standby } = makeDriver();
    driver.loadStandby('https://cdn/b.mp3');

    expect(standby.src).toBe('https://cdn/b.mp3');
    expect(standby.preload).toBe('auto');
    expect(standby.load).toHaveBeenCalled();
  });

  // A standby that has a URL but no buffered data would stall on promotion.
  it('reports standby only once readyState reaches HAVE_CURRENT_DATA', () => {
    const { driver, standby } = makeDriver();
    driver.loadStandby('https://cdn/b.mp3');
    expect(driver.hasStandby()).toBe(false);

    standby.readyState = 2;
    expect(driver.hasStandby()).toBe(true);
  });

  it('swaps elements on promote so handlers follow the new current', async () => {
    const { driver, current, standby } = makeDriver();
    driver.loadCurrent('https://cdn/a.mp3');
    driver.loadStandby('https://cdn/b.mp3');
    standby.readyState = 2;

    driver.promoteStandby();
    await driver.play();

    expect(standby.play).toHaveBeenCalled();
    expect(current.play).not.toHaveBeenCalled();
  });

  it('unlock primes both elements so the standby can autoplay later', () => {
    const { driver, current, standby } = makeDriver();
    driver.unlock();

    expect(current.play).toHaveBeenCalled();
    expect(current.pause).toHaveBeenCalled();
    expect(standby.play).toHaveBeenCalled();
    expect(standby.pause).toHaveBeenCalled();
  });

  it('forwards ended, timeupdate, waiting, playing and error', () => {
    const { driver, current } = makeDriver();
    const handlers = {
      ended: vi.fn(), timeupdate: vi.fn(), waiting: vi.fn(), playing: vi.fn(), error: vi.fn(),
    };
    for (const [event, handler] of Object.entries(handlers)) {
      driver.on(event as 'ended', handler);
    }

    for (const type of ['ended', 'timeupdate', 'waiting', 'playing', 'error']) current.dispatch(type);

    for (const handler of Object.values(handlers)) expect(handler).toHaveBeenCalledTimes(1);
  });

  it('stop pauses both elements, clears src, and reloads to fully release the network resource', () => {
    const { driver, current, standby } = makeDriver();
    driver.loadCurrent('https://cdn/a.mp3');
    driver.loadStandby('https://cdn/b.mp3');
    standby.readyState = 2;
    // loadCurrent/loadStandby already called load() once each; clear that
    // so the assertions below can only pass if stop() calls it again.
    current.load.mockClear();
    standby.load.mockClear();

    driver.stop();

    expect(current.pause).toHaveBeenCalled();
    expect(current.removeAttribute).toHaveBeenCalledWith('src');
    expect(current.load).toHaveBeenCalled();
    expect(standby.pause).toHaveBeenCalled();
    expect(standby.removeAttribute).toHaveBeenCalledWith('src');
    expect(standby.load).toHaveBeenCalled();
  });

  it('stop leaves hasStandby false afterwards', () => {
    const { driver, standby } = makeDriver();
    driver.loadStandby('https://cdn/b.mp3');
    standby.readyState = 2;
    expect(driver.hasStandby()).toBe(true);

    driver.stop();

    expect(driver.hasStandby()).toBe(false);
  });

  it('destroy clears registered handlers so a later DOM event invokes nothing', () => {
    const { driver, current } = makeDriver();
    const onEnded = vi.fn();
    driver.on('ended', onEnded);

    driver.destroy();
    current.dispatch('ended');

    expect(onEnded).not.toHaveBeenCalled();
  });

  it('promoteStandby releases the demoted element with load, not just removeAttribute', () => {
    const { driver, current, standby } = makeDriver();
    driver.loadCurrent('https://cdn/a.mp3');
    driver.loadStandby('https://cdn/b.mp3');
    standby.readyState = 2;
    // `current` already had load() called once by loadCurrent; clear that
    // so the assertion below can only pass if promoteStandby calls it again.
    current.load.mockClear();

    driver.promoteStandby();

    // `current` (the demoted element, now standby) must be fully released.
    expect(current.removeAttribute).toHaveBeenCalledWith('src');
    expect(current.load).toHaveBeenCalled();
  });

  it('maps stalled onto waiting', () => {
    const { driver, current } = makeDriver();
    const onWaiting = vi.fn();
    driver.on('waiting', onWaiting);

    current.dispatch('stalled');

    expect(onWaiting).toHaveBeenCalledTimes(1);
  });

  // canplay fires when playback *could* start. Reporting a start then would
  // misreport the listen, so it must not surface as 'playing'.
  it('does not map canplay onto playing', () => {
    const { driver, current } = makeDriver();
    const onPlaying = vi.fn();
    driver.on('playing', onPlaying);

    current.dispatch('canplay');

    expect(onPlaying).not.toHaveBeenCalled();
  });
});
