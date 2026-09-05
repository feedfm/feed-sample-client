import type { AudioDriver, AudioEvent } from '../src/audio/driver.js';

export class FakeAudioDriver implements AudioDriver {
  currentUrl: string | undefined;
  standbyUrl: string | undefined;
  playCalls = 0;
  pauseCalls = 0;
  stopCalls = 0;
  unlockCalls = 0;

  /** Set this to make the next play() reject, simulating a load failure. */
  playRejection: Error | undefined;

  #time = 0;
  #standbyReady = false;
  readonly #handlers = new Map<AudioEvent, Set<() => void>>();

  loadCurrent(url: string, startAt = 0): void {
    this.currentUrl = url;
    this.#time = startAt;
  }

  loadStandby(url: string, _startAt = 0): void {
    this.standbyUrl = url;
    this.#standbyReady = false;
  }

  hasStandby(): boolean {
    return this.standbyUrl !== undefined && this.#standbyReady;
  }

  promoteStandby(): void {
    this.currentUrl = this.standbyUrl;
    this.standbyUrl = undefined;
    this.#standbyReady = false;
    this.#time = 0;
  }

  async play(): Promise<void> {
    this.playCalls += 1;
    if (this.playRejection !== undefined) {
      const rejection = this.playRejection;
      this.playRejection = undefined;
      throw rejection;
    }
  }

  pause(): void {
    this.pauseCalls += 1;
  }

  stop(): void {
    this.stopCalls += 1;
    this.currentUrl = undefined;
    this.standbyUrl = undefined;
    this.#standbyReady = false;
    this.#time = 0;
  }

  unlock(): void {
    this.unlockCalls += 1;
  }

  currentTime(): number {
    return this.#time;
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
    this.#handlers.clear();
  }

  // --- test controls ---

  fire(event: AudioEvent): void {
    for (const handler of [...(this.#handlers.get(event) ?? [])]) handler();
  }

  setCurrentTime(seconds: number): void {
    this.#time = seconds;
  }

  markStandbyReady(): void {
    this.#standbyReady = true;
  }
}
