import type { FeedApiClient } from '../api/client.js';
import type { Play, SearchPlay } from '../api/schema.js';
import type { AudioDriver } from '../audio/driver.js';
import { ErrorCode, FeedError } from '../errors.js';
import type { Player, PlayerEvents, PlayerStatus, SongMetadata, Station, StopReason } from '../types.js';
import { Emitter } from './emitter.js';
import { ReservationStore, isReservationFresh } from './reservations.js';
import { toPublicStation, toStationRecord, type StationRecord } from './stations.js';

export interface PlayerDeps {
  client: FeedApiClient;
  driver: AudioDriver;
  clientId: string;
  stations?: StationRecord[];
  now?: () => number;
}

interface ActivePlay {
  play: Play | SearchPlay;
  started: boolean;
  canSkip: boolean;
}

/** A station that matched but has nothing playable is, to the caller, no station. */
const NOT_PLAYABLE = new Set<number>([
  ErrorCode.missingObject,
  ErrorCode.noMoreMusic,
  ErrorCode.formatUnavailable,
]);

export class PlayerImpl implements Player {
  readonly #client: FeedApiClient;
  readonly #driver: AudioDriver;
  readonly #clientId: string;
  readonly #now: () => number;

  readonly #emitter = new Emitter<PlayerEvents>();
  readonly #stations = new Map<string, StationRecord>();
  readonly #reservations = new ReservationStore();

  #status: PlayerStatus = 'stopped';
  #bufferingFlag = false;
  #activeStation: StationRecord | null = null;
  #activePlay: ActivePlay | null = null;
  #nextPlay: Play | null = null;

  #generation = 0;
  #playsStartedCount = 0;
  #consecutiveFailures = 0;
  #expiryRefetches = 0;

  constructor(deps: PlayerDeps) {
    this.#client = deps.client;
    this.#driver = deps.driver;
    this.#clientId = deps.clientId;
    this.#now = deps.now ?? (() => Date.now());

    for (const record of deps.stations ?? []) this.#stations.set(record.uuid, record);
  }

  clientId(): string {
    return this.#clientId;
  }

  status(): PlayerStatus {
    return this.#status;
  }

  buffering(): boolean {
    return this.#bufferingFlag;
  }

  activeSong(): SongMetadata | null {
    if (this.#activePlay === null) return null;
    const file = this.#activePlay.play.audio_file;
    return {
      title: file.track.title,
      artist: file.artist.name,
      release: file.release.title,
      durationInSeconds: file.duration_in_seconds,
      elapsedInSeconds: this.#driver.currentTime(),
    };
  }

  on<K extends keyof PlayerEvents>(event: K, handler: PlayerEvents[K]): void {
    this.#emitter.on(event, handler);
  }

  off<K extends keyof PlayerEvents>(event: K, handler: PlayerEvents[K]): void {
    this.#emitter.off(event, handler);
  }

  async findStation(query: string): Promise<Station | null> {
    try {
      const play = await this.#client.searchStation({ filter: { name: query } });
      return toPublicStation(this.#recordSearchResult(play));
    } catch (error) {
      if (error instanceof FeedError && NOT_PLAYABLE.has(error.code)) return null;
      throw error;
    }
  }

  // --- Task 11/13 stubs: keep this class satisfying `Player` until those tasks land. ---
  play(_station: Station): void { /* Task 11 */ }
  pause(): void { /* Task 13 */ }
  resume(): void { /* Task 13 */ }
  async skip(): Promise<boolean> { return false; /* Task 13 */ }
  stop(): void { /* Task 11 */ }

  /** Stores the station and the play the search reserved as a side effect. */
  #recordSearchResult(play: SearchPlay): StationRecord {
    const record = toStationRecord(play.station);
    this.#stations.set(record.uuid, record);
    this.#reservations.put(record.uuid, {
      play,
      reservedAt: this.#now(),
      startedCountAtReserve: this.#playsStartedCount,
    });
    return record;
  }

  #setBuffering(value: boolean): void {
    if (this.#bufferingFlag === value) return;
    this.#bufferingFlag = value;
    this.#emitter.emit(value ? 'buffering-started' : 'buffering-ended');
  }

  #emitError(error: unknown): void {
    this.#emitter.emit(
      'error',
      error instanceof FeedError
        ? error
        : new FeedError(ErrorCode.networkError, error instanceof Error ? error.message : 'unknown error', 0),
    );
  }
}
