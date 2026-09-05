import type { FeedApiClient } from '../api/client.js';
import type { Play, SearchPlay } from '../api/schema.js';
import type { AudioDriver } from '../audio/driver.js';
import { ELAPSE_INTERVAL_MS, TICK_INTERVAL_MS } from '../config.js';
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

  #tickTimer: ReturnType<typeof setInterval> | undefined;
  #elapseTimer: ReturnType<typeof setInterval> | undefined;
  #audioBound = false;

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

  play(station: Station): void {
    if (this.#activeStation?.uuid === station.uuid) {
      if (this.#status === 'paused') { this.resume(); return; }
      if (this.#status === 'playing') return;
    }
    void this.#startStation(station);
  }

  stop(): void {
    if (this.#status === 'stopped') return;
    this.#teardown('stopped-by-caller');
  }

  async #startStation(station: Station): Promise<void> {
    this.#bindAudio();
    if (this.#status !== 'stopped') this.#teardown('superseded');

    const generation = ++this.#generation;
    this.#activeStation =
      this.#stations.get(station.uuid) ??
      { uuid: station.uuid, id: '', name: station.name, options: station.options };
    this.#status = 'playing';
    this.#consecutiveFailures = 0;
    this.#expiryRefetches = 0;
    this.#setBuffering(true);
    this.#driver.unlock();

    try {
      const play = await this.#obtainPlay(station.uuid, generation);
      if (generation !== this.#generation) return;
      await this.#beginPlayback(play, generation);
    } catch (error) {
      this.#failStart(error, generation);
    }
  }

  /**
   * A fresh reservation is used as-is. A stale one is simply dropped — an
   * unused play needs no invalidate — and replaced by a new reservation.
   */
  async #obtainPlay(uuid: string, generation: number): Promise<Play | SearchPlay> {
    const reserved = this.#reservations.take(uuid);
    if (reserved !== undefined && isReservationFresh(reserved, this.#playsStartedCount, this.#now())) {
      return reserved.play;
    }

    const record = this.#stations.get(uuid);
    if (record !== undefined && record.id !== '') return this.#client.createPlay(record.id);

    // No internal record: uuid is the stable way to name one station.
    const play = await this.#client.searchStation({ filter: { uuid } });
    if (generation !== this.#generation) return play; // caller's guard discards it
    this.#activeStation = this.#recordSearchResult(play);
    this.#reservations.take(uuid);
    return play;
  }

  async #beginPlayback(play: Play | SearchPlay, generation: number): Promise<void> {
    const url = play.audio_file.url;
    if (url === undefined) {
      throw new FeedError(ErrorCode.networkError, 'play carried no audio url', 200);
    }

    this.#activePlay = { play, started: false, canSkip: false };
    this.#driver.loadCurrent(url, play.start_at ?? 0);

    try {
      await this.#driver.play();
    } catch (error) {
      if (generation === this.#generation) await this.#handleLoadFailure(play, generation);
    }
  }

  #bindAudio(): void {
    if (this.#audioBound) return;
    this.#audioBound = true;
    this.#driver.on('playing', () => { this.#onAudioPlaying(); });
    this.#driver.on('ended', () => { this.#onAudioEnded(); });
    this.#driver.on('waiting', () => { if (this.#status === 'playing') this.#setBuffering(true); });
    this.#driver.on('error', () => { this.#onAudioError(); });
  }

  /** Audio has genuinely started, so the listen may now be reported. */
  #onAudioPlaying(): void {
    const active = this.#activePlay;
    if (active === null) {
      return;
    }
    if (active.started) {
      this.#setBuffering(false);
      return;
    }

    active.started = true;
    this.#playsStartedCount += 1;
    this.#consecutiveFailures = 0;
    this.#expiryRefetches = 0;

    const generation = this.#generation;
    void this.#client
      .startPlay(active.play.id)
      .then((rights) => { if (generation === this.#generation) active.canSkip = rights.canSkip; })
      .catch((error: unknown) => { this.#emitError(error); });

    this.#setBuffering(false);
    this.#startTimers();

    const song = this.activeSong();
    if (song !== null) this.#emitter.emit('play-started', song);

    void this.#reserveNext(generation);
  }

  /** Retrieving audio is faster than playing it, so fetch the next song now. */
  async #reserveNext(generation: number): Promise<void> {
    const station = this.#activeStation;
    if (station === null || station.id === '') return;

    try {
      const play = await this.#client.createPlay(station.id);
      if (generation !== this.#generation) return;

      this.#nextPlay = play;
      if (play.audio_file.url !== undefined) {
        this.#driver.loadStandby(play.audio_file.url, play.start_at ?? 0);
      }
    } catch (error) {
      // Running dry is handled when we actually try to advance.
      if (error instanceof FeedError && error.code === ErrorCode.noMoreMusic) return;
      this.#emitError(error);
    }
  }

  #startTimers(): void {
    this.#stopTimers();
    this.#tickTimer = setInterval(() => {
      const song = this.activeSong();
      if (song !== null) this.#emitter.emit('play-elapsed', song);
    }, TICK_INTERVAL_MS);
    this.#elapseTimer = setInterval(() => {
      this.#reportElapse(this.#activePlay);
    }, ELAPSE_INTERVAL_MS);
  }

  #stopTimers(): void {
    if (this.#tickTimer !== undefined) clearInterval(this.#tickTimer);
    if (this.#elapseTimer !== undefined) clearInterval(this.#elapseTimer);
    this.#tickTimer = undefined;
    this.#elapseTimer = undefined;
  }

  #reportElapse(active: ActivePlay | null): void {
    if (active === null || !active.started) return;
    void this.#client
      .elapsePlay(active.play.id, this.#driver.currentTime())
      .catch((error: unknown) => { this.#emitError(error); });
  }

  #teardown(reason: StopReason): void {
    const active = this.#activePlay;
    const hadPlayback = active !== null || this.#activeStation !== null;

    this.#stopTimers();
    this.#reportElapse(active);
    this.#driver.stop();

    // Discarded, never invalidated: an unstarted play stays queued server-side.
    this.#nextPlay = null;
    this.#activePlay = null;
    this.#activeStation = null;
    this.#status = 'stopped';
    this.#setBuffering(false);
    this.#generation += 1;

    if (hadPlayback) this.#emitter.emit('play-stopped', { reason });
  }

  #failStart(error: unknown, generation: number): void {
    if (generation !== this.#generation) return;
    if (error instanceof FeedError && error.code === ErrorCode.noMoreMusic) {
      this.#teardown('ended');
      return;
    }
    this.#emitError(error);
    this.#teardown('error');
  }

  #onAudioEnded(): void {
    void this.#advance(this.#generation, { complete: true });
  }

  /**
   * Moves to the next song. `complete: false` is used after a granted skip,
   * which has already closed the play out server-side.
   */
  async #advance(generation: number, options: { complete: boolean }): Promise<void> {
    const finished = this.#activePlay;
    this.#activePlay = null;
    this.#stopTimers();

    if (finished !== null && options.complete) {
      void this.#client
        .completePlay(finished.play.id)
        .catch((error: unknown) => { this.#emitError(error); });
    }

    const next = this.#nextPlay;
    this.#nextPlay = null;

    // The happy path: the next song is already buffered, so there is no wait
    // and nothing to report as buffering.
    if (next !== null && this.#driver.hasStandby()) {
      this.#driver.promoteStandby();
      this.#activePlay = { play: next, started: false, canSkip: false };
      try {
        await this.#driver.play();
      } catch {
        if (generation === this.#generation) await this.#handleLoadFailure(next, generation);
      }
      return;
    }

    this.#setBuffering(true);

    const station = this.#activeStation;
    if (station === null) return;

    try {
      const play = next ?? (await this.#client.createPlay(station.id));
      if (generation !== this.#generation) return;
      await this.#beginPlayback(play, generation);
    } catch (error) {
      this.#failStart(error, generation);
    }
  }

  #onAudioError(): void { /* Task 14 */ }
  async #handleLoadFailure(_play: Play | SearchPlay, _generation: number): Promise<void> { /* Task 14 */ }
  pause(): void { /* Task 13 */ }
  resume(): void { /* Task 13 */ }
  async skip(): Promise<boolean> { return false; /* Task 13 */ }

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
