export type AudioEvent = 'ended' | 'timeupdate' | 'waiting' | 'playing' | 'error';

/**
 * The only abstraction over the DOM. Everything above it runs in node against
 * FakeAudioDriver, which is what makes the player's sequencing testable.
 */
export interface AudioDriver {
  /** Load into the element that is or will be playing. */
  loadCurrent(url: string, startAt?: number): void;

  /** Preload the next song into the standby element while the current plays. */
  loadStandby(url: string, startAt?: number): void;

  /** True only when the standby element has actually buffered, not merely been assigned a URL. */
  hasStandby(): boolean;

  /** Swap standby into current. This is how playback advances without a gap. */
  promoteStandby(): void;

  play(): Promise<void>;
  pause(): void;

  /** Pause and release both elements. */
  stop(): void;

  /**
   * Satisfy autoplay policy for both elements from within a user gesture. The
   * standby element has never been touched by one, so it needs this before it
   * can be promoted and played.
   */
  unlock(): void;

  currentTime(): number;
  on(event: AudioEvent, handler: () => void): void;
  destroy(): void;
}
