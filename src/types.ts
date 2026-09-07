import type { FeedError } from './errors.js';

export interface ConnectOptions {
  token: string;
  secret: string;
  clientId?: string;
  baseUrl?: string;
}

/**
 * A station, addressed by uuid. The numeric station id the API uses is
 * internal to the SDK and never appears here.
 */
export interface Station {
  uuid: string;
  name: string;
  options: Record<string, unknown>;
}

export interface SongMetadata {
  title: string;
  artist: string;
  release: string;
  durationInSeconds: number;
  elapsedInSeconds: number;
}

export type PlayerStatus = 'stopped' | 'playing' | 'paused';

export type StopReason = 'ended' | 'stopped-by-caller' | 'superseded' | 'error';

export interface PlayerEvents {
  'play-started': (song: SongMetadata) => void;
  'play-elapsed': (song: SongMetadata) => void;
  'play-paused': (song: SongMetadata) => void;
  'play-stopped': (info: { reason: StopReason }) => void;
  'buffering-started': () => void;
  'buffering-ended': () => void;
  error: (error: FeedError) => void;
}

export interface Player {
  clientId(): string;
  status(): PlayerStatus;
  buffering(): boolean;
  activeSong(): SongMetadata | null;
  /**
   * Prepare the audio elements for playback. Call this synchronously from a
   * user gesture - a click or tap - before any station is known. Browsers only
   * permit audio that a gesture initiated, and an awaited `findStation` spends
   * that gesture, so unlocking here is what lets you resolve a station
   * asynchronously and play it afterwards.
   *
   * Safe to call more than once. `play` unlocks too, so callers that already
   * resolve a station ahead of the gesture need not change.
   */
  unlockAudio(): void;

  findStation(query: string): Promise<Station | null>;
  play(station: Station): void;
  pause(): void;
  resume(): void;
  skip(): Promise<boolean>;
  stop(): void;
  on<K extends keyof PlayerEvents>(event: K, handler: PlayerEvents[K]): void;
  off<K extends keyof PlayerEvents>(event: K, handler: PlayerEvents[K]): void;
}
