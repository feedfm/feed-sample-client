import type { AudioDriver, AudioEvent } from './driver.js';

/** HTMLMediaElement.HAVE_CURRENT_DATA */
const HAVE_CURRENT_DATA = 2;

const DOM_TO_AUDIO_EVENT: ReadonlyArray<readonly [string, AudioEvent]> = [
  ['ended', 'ended'],
  ['timeupdate', 'timeupdate'],
  ['waiting', 'waiting'],
  ['stalled', 'waiting'],
  ['playing', 'playing'],
  ['error', 'error'],
  // `canplay` is deliberately absent: it means playback *could* begin, not
  // that it has, and POST /play/{id}/start must report the real moment.
];

export interface HtmlAudioDriverOptions {
  createElement?: () => HTMLAudioElement;
}

export class HtmlAudioDriver implements AudioDriver {
  #current: HTMLAudioElement;
  #standby: HTMLAudioElement;

  readonly #handlers = new Map<AudioEvent, Set<() => void>>();

  constructor(options: HtmlAudioDriverOptions = {}) {
    const create = options.createElement ?? (() => new Audio());
    this.#current = create();
    this.#standby = create();

    // Listen on both, so a promotion needs no re-binding.
    for (const element of [this.#current, this.#standby]) this.#bind(element);
  }

  #bind(element: HTMLAudioElement): void {
    for (const [domEvent, audioEvent] of DOM_TO_AUDIO_EVENT) {
      element.addEventListener(domEvent, () => {
        // Only the element actually playing may speak for the player.
        if (element !== this.#current) return;
        for (const handler of [...(this.#handlers.get(audioEvent) ?? [])]) handler();
      });
    }
  }

  #load(element: HTMLAudioElement, url: string, startAt: number): void {
    element.src = url;
    element.preload = 'auto';
    if (startAt > 0) {
      element.addEventListener('loadedmetadata', () => { element.currentTime = startAt; }, { once: true });
    }
    element.load();
  }

  loadCurrent(url: string, startAt = 0): void {
    this.#load(this.#current, url, startAt);
  }

  loadStandby(url: string, startAt = 0): void {
    this.#load(this.#standby, url, startAt);
  }

  hasStandby(): boolean {
    return this.#standby.src !== '' && this.#standby.readyState >= HAVE_CURRENT_DATA;
  }

  promoteStandby(): void {
    const previous = this.#current;
    this.#current = this.#standby;
    this.#standby = previous;

    this.#standby.pause();
    this.#standby.removeAttribute('src');
    this.#standby.load();
  }

  async play(): Promise<void> {
    await this.#current.play();
  }

  pause(): void {
    this.#current.pause();
  }

  stop(): void {
    for (const element of [this.#current, this.#standby]) {
      element.pause();
      element.removeAttribute('src');
      element.load();
    }
  }

  /**
   * Autoplay policy is per element. The standby has never been touched by a
   * user gesture, so without this it refuses to play once promoted.
   */
  unlock(): void {
    for (const element of [this.#current, this.#standby]) {
      void Promise.resolve(element.play()).catch(() => undefined);
      element.pause();
    }
  }

  currentTime(): number {
    return this.#current.currentTime;
  }

  on(event: AudioEvent, handler: () => void): void {
    let set = this.#handlers.get(event);
    if (set === undefined) {
      set = new Set();
      this.#handlers.set(event, set);
    }
    set.add(handler);
  }

  destroy(): void {
    this.stop();
    this.#handlers.clear();
  }
}
