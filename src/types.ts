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
  findStation(query: string): Promise<Station | null>;
  play(station: Station): void;
  pause(): void;
  resume(): void;
  skip(): Promise<boolean>;
  stop(): void;
  on<K extends keyof PlayerEvents>(event: K, handler: PlayerEvents[K]): void;
  off<K extends keyof PlayerEvents>(event: K, handler: PlayerEvents[K]): void;
}
