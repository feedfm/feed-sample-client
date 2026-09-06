import type { AudioDriver, AudioEvent } from '../src/audio/driver.js';

interface PendingPlay {
  resolve: () => void;
  reject: (reason: unknown) => void;
}

/** A DOMException-shaped rejection, as a browser produces. */
function domError(name: string, message: string): Error {
  if (typeof DOMException === 'function') return new DOMException(message, name);
  const error = new Error(message);
  error.name = name;
  return error;
}

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

  /**
   * A real play() promise does not settle when it is called — it settles when
   * playback actually begins, and until then anything that interrupts the
   * element rejects it. Modelling that is the whole point: a fake that
   * resolved immediately could not reproduce the AbortError that pause()
   * delivers to a load still in flight.
   */
  readonly #pendingPlays: PendingPlay[] = [];

  loadCurrent(url: string, startAt = 0): void {
    // Assigning a new source aborts a play() still waiting on the old one.
    this.#abortPendingPlays('The play() request was interrupted by a new load request.');
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
    // The outgoing element is paused as it is swapped out.
    this.#abortPendingPlays('The play() request was interrupted by a call to pause().');
    this.currentUrl = this.standbyUrl;
    this.standbyUrl = undefined;
    this.#standbyReady = false;
    this.#time = 0;
  }

  play(): Promise<void> {
    this.playCalls += 1;
    if (this.playRejection !== undefined) {
      const rejection = this.playRejection;
      this.playRejection = undefined;
      return Promise.reject(rejection);
    }
    return new Promise<void>((resolve, reject) => {
      this.#pendingPlays.push({ resolve, reject });
    });
  }

  pause(): void {
    this.pauseCalls += 1;
    // Per the HTML spec, pause() rejects every pending play() promise. This is
    // the familiar "The play() request was interrupted by a call to pause()".
    this.#abortPendingPlays('The play() request was interrupted by a call to pause().');
  }

  stop(): void {
    this.stopCalls += 1;
    this.#abortPendingPlays('The play() request was interrupted by a call to pause().');
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

    // `playing` is the moment playback truly began, which is when the element
    // settles its play() promise. An `error` rejects it instead.
    if (event === 'playing') this.#settlePendingPlays();
    if (event === 'error') {
      this.#abortPendingPlays('Failed to load because no supported source was found.', 'NotSupportedError');
    }
  }

  setCurrentTime(seconds: number): void {
    this.#time = seconds;
  }

  markStandbyReady(): void {
    this.#standbyReady = true;
  }

  /** True while a play() promise is still waiting on playback to begin. */
  hasPendingPlay(): boolean {
    return this.#pendingPlays.length > 0;
  }

  #settlePendingPlays(): void {
    for (const pending of this.#pendingPlays.splice(0)) pending.resolve();
  }

  #abortPendingPlays(message: string, name = 'AbortError'): void {
    for (const pending of this.#pendingPlays.splice(0)) pending.reject(domError(name, message));
  }
}
