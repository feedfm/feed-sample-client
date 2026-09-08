import type { FeedApiClient } from '../api/client.js';
import type { Play, SearchPlay } from '../api/schema.js';
import type { AudioDriver } from '../audio/driver.js';
import {
  ELAPSE_INTERVAL_MS,
  MAX_CONSECUTIVE_PLAY_FAILURES,
  MAX_EXPIRY_REFETCHES,
  MAX_TOTAL_PLAY_FAILURES,
  PLAY_RETRY_BACKOFF_MS,
  TICK_INTERVAL_MS,
  URL_EXPIRY_MARGIN_SECONDS,
} from '../config.js';
import { ErrorCode, FeedError } from '../errors.js';
import type { Player, PlayerEvents, PlayerStatus, SongMetadata, Station, StopReason } from '../types.js';
import { urlExpiry } from '../url-expiry.js';
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

/**
 * Browsers reject `play()` with a `DOMException`, which subclasses `Error`;
 * the name is matched rather than the class so a rejection that crossed a
 * realm boundary is still recognised.
 */
function isDomError(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

/**
 * Spec section 6, recovery path 2. A 5xx or a dropped connection is worth
 * exactly one retry; a 4xx is a decision, not a hiccup. Every failure also
 * counts toward the code-22 throttle (10 errors in 5 minutes), so a
 * `throttled` response is never retried - that only digs the hole deeper.
 */
function isRetriablePlayFailure(error: unknown): boolean {
  if (!(error instanceof FeedError)) return false;
  if (error.code === ErrorCode.throttled) return false;
  return error.code === ErrorCode.networkError || error.status >= 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export class PlayerImpl implements Player {
  readonly #client: FeedApiClient;
  readonly #driver: AudioDriver;
  readonly #clientId: string;
  readonly #now: () => number;

  readonly #emitter = new Emitter<PlayerEvents>();
  readonly #stations = new Map<string, StationRecord>();
  readonly #defaultStations: readonly StationRecord[];
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

  /**
   * Never reset, unlike the two counters above, which both clear every time
   * audio starts. It is the only bound on a station that can start a song and
   * then break it, over and over.
   */
  #totalFailures = 0;

  /**
   * The id of the play `#handleLoadFailure` is currently recovering from, so
   * a second failure signal for that same play (a real `<audio>` element can
   * both reject `play()` and dispatch its own `error` event for one broken
   * load) is dropped instead of being counted and invalidated twice.
   */
  #recoveringPlayId: string | null = null;

  #tickTimer: ReturnType<typeof setInterval> | undefined;
  #elapseTimer: ReturnType<typeof setInterval> | undefined;
  #audioBound = false;

  constructor(deps: PlayerDeps) {
    this.#client = deps.client;
    this.#driver = deps.driver;
    this.#clientId = deps.clientId;
    this.#now = deps.now ?? (() => Date.now());

    for (const record of deps.stations ?? []) this.#stations.set(record.uuid, record);
    // Held separately from #stations, which findStation also writes to: this
    // list describes the session and must not grow as the caller searches.
    this.#defaultStations = [...(deps.stations ?? [])];
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

  defaultStations(): Station[] {
    // A fresh array of fresh objects: a caller cannot reach into player state.
    return this.#defaultStations.map(toPublicStation);
  }

  unlockAudio(): void {
    this.#driver.unlock();
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
    if (record !== undefined && record.id !== '') return this.#createPlay(record.id);

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

    // A new attempt is starting, so any earlier recovery is done with.
    this.#recoveringPlayId = null;
    const active: ActivePlay = { play, started: false, canSkip: false };
    this.#activePlay = active;
    this.#driver.loadCurrent(url, play.start_at ?? 0);

    try {
      await this.#driver.play();
    } catch (error) {
      if (this.#wasInterrupted(error, generation, active)) return;
      await this.#handleLoadFailure(play, generation);
    }
  }

  /**
   * Decides whether a rejected `driver.play()` is a load failure at all.
   *
   * `HTMLMediaElement.pause()` - and a new `load()` on the same element -
   * rejects every pending `play()` promise with `AbortError`, and neither
   * bumps `#generation`. Treating that as a bad file invalidates a perfectly
   * good play, then starts audio the listener has just paused. So the same
   * discipline `resume()` uses applies here: check the generation, the song,
   * and the status before blaming the file.
   *
   * Returns true when the rejection has been dealt with and must not reach
   * `#handleLoadFailure`.
   */
  #wasInterrupted(error: unknown, generation: number, active: ActivePlay): boolean {
    if (generation !== this.#generation) return true;
    // #advance() and skip() move to a new song without bumping #generation,
    // so generation alone does not identify the song this attempt was for.
    if (this.#activePlay !== active) return true;
    if (this.#status !== 'playing') return true;
    // Interrupted by pause(), or by loading a new source. A file that is
    // genuinely broken also dispatches an `error` event, which is handled.
    if (isDomError(error, 'AbortError')) return true;

    if (isDomError(error, 'NotAllowedError')) {
      // Autoplay policy, not a bad play. The play is left intact so a later
      // user gesture can retry it, exactly as resume() does.
      this.#status = 'paused';
      this.#stopTimers();
      this.#setBuffering(false);
      this.#emitError(error);
      const song = this.activeSong();
      if (song !== null) this.#emitter.emit('play-paused', song);
      return true;
    }

    return false;
  }

  /** POST /play, with the single retry the spec allows. */
  async #createPlay(stationId: string): Promise<Play> {
    try {
      return await this.#client.createPlay(stationId);
    } catch (error) {
      if (!isRetriablePlayFailure(error)) throw error;
      await delay(PLAY_RETRY_BACKOFF_MS);
      return this.#client.createPlay(stationId);
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
      .catch((error: unknown) => { this.#emitError(error); })
      // Chained, not raced: POST /play keeps returning the play that is
      // already playing until its start has committed (section 9), so issuing
      // both in one tick can reserve the current song as the next one.
      // Nothing waits on this - the audio is already running.
      .then(() => this.#reserveNext(generation));

    this.#setBuffering(false);
    this.#startTimers();

    const song = this.activeSong();
    if (song !== null) this.#emitter.emit('play-started', song);
  }

  /** Retrieving audio is faster than playing it, so fetch the next song now. */
  /**
   * Drops a reserve that landed while we were awaiting a play of our own and
   * duplicates it. POST /play hands back the same play until one is started, so
   * a reserve in flight when a song ends can return what #advance just fetched;
   * keeping both would start and complete one play id twice.
   */
  #dropDuplicateReserve(playId: string): void {
    if (this.#nextPlay !== null && this.#nextPlay.id === playId) this.#nextPlay = null;
  }

  async #reserveNext(generation: number): Promise<void> {
    const station = this.#activeStation;
    if (station === null || station.id === '') return;
    if (this.#nextPlay !== null) return;

    try {
      const play = await this.#createPlay(station.id);
      if (generation !== this.#generation) return;
      // A song can end while this reserve is in flight, and #advance() does
      // not bump #generation - so both can fetch, and POST /play hands the
      // same play to each. Playing it twice would repeat the song and report
      // `complete` twice for one play id. An unused play is simply dropped.
      if (this.#activePlay?.play.id === play.id || this.#nextPlay !== null) return;

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
    this.#recoveringPlayId = null;
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
    // A stray `ended` after teardown would otherwise reach #setBuffering(true)
    // below and strand buffering() true while status() reads 'stopped'.
    // #onAudioEnded passes the *current* generation, so the status is the
    // load-bearing half of this guard: buffering is only ever true while
    // playing, and nothing may start audio the listener has paused.
    if (generation !== this.#generation || this.#status !== 'playing') return;

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
      // A new attempt is starting, so any earlier recovery is done with.
      this.#recoveringPlayId = null;
      const active: ActivePlay = { play: next, started: false, canSkip: false };
      this.#activePlay = active;
      try {
        await this.#driver.play();
      } catch (error) {
        if (this.#wasInterrupted(error, generation, active)) return;
        await this.#handleLoadFailure(next, generation);
      }
      return;
    }

    this.#setBuffering(true);

    const station = this.#activeStation;
    if (station === null) return;

    try {
      const play = next ?? (await this.#createPlay(station.id));
      if (generation !== this.#generation) return;
      // A reserve that was still in flight when this advance began can land the
      // same play in #nextPlay while we awaited - POST /play hands back the same
      // play until one is started. Promoting it later would start and complete
      // one play id twice. An unused play is simply dropped.
      this.#dropDuplicateReserve(play.id);
      await this.#beginPlayback(play, generation);
    } catch (error) {
      this.#failStart(error, generation);
    }
  }

  #onAudioError(): void {
    const active = this.#activePlay;
    if (active === null) return;

    // Section 6's recovery is scoped to audio that fails *to load*. A play
    // that has already reported its start is a real listen: report what was
    // heard and move on. Invalidating here would throw away a play the server
    // has recorded as started and lose up to ELAPSE_INTERVAL_MS of listening.
    if (active.started) {
      this.#reportElapse(active);
      void this.#advance(this.#generation, { complete: false });
      return;
    }

    void this.#handleLoadFailure(active.play, this.#generation);
  }

  /**
   * Two very different failures arrive here, and the URL says which.
   *
   * An expired signature means the song is fine — POST /play re-signs it — so
   * the play is discarded and re-fetched, with no invalidate.
   *
   * Anything else means the file itself is unplayable, and invalidate is the
   * only way to stop POST /play handing back the identical broken play.
   */
  async #handleLoadFailure(play: Play | SearchPlay, generation: number): Promise<void> {
    if (generation !== this.#generation) return;
    // A real <audio> element can both reject play() and dispatch its own
    // error event for the same broken load; a second entry for the play
    // already being recovered is dropped rather than double-counted.
    if (this.#recoveringPlayId === play.id) return;
    this.#recoveringPlayId = play.id;

    this.#totalFailures += 1;
    if (this.#totalFailures >= MAX_TOTAL_PLAY_FAILURES) {
      this.#emitError(new FeedError(ErrorCode.networkError, 'too many audio failures this session', 0));
      this.#teardown('error');
      return;
    }

    const url = play.audio_file.url;
    const expiry = url === undefined
      ? 'unknown'
      : urlExpiry(url, URL_EXPIRY_MARGIN_SECONDS, this.#now());

    if (expiry === 'expired') {
      if (this.#expiryRefetches >= MAX_EXPIRY_REFETCHES) {
        this.#emitError(new FeedError(ErrorCode.networkError, 'audio url kept arriving expired', 0));
        this.#teardown('error');
        return;
      }
      this.#expiryRefetches += 1;
      await this.#retryWithFreshPlay(generation);
      return;
    }

    this.#consecutiveFailures += 1;
    void this.#client
      .invalidatePlay(play.id, 'audio failed to load')
      .catch(() => undefined);

    if (this.#consecutiveFailures >= MAX_CONSECUTIVE_PLAY_FAILURES) {
      this.#emitError(new FeedError(ErrorCode.networkError, 'audio repeatedly failed to load', 0));
      this.#teardown('error');
      return;
    }

    await this.#retryWithFreshPlay(generation);
  }

  async #retryWithFreshPlay(generation: number): Promise<void> {
    const station = this.#activeStation;
    if (station === null || station.id === '') return;

    this.#setBuffering(true);

    try {
      const play = await this.#createPlay(station.id);
      if (generation !== this.#generation) return;
      await this.#beginPlayback(play, generation);
    } catch (error) {
      this.#failStart(error, generation);
    }
  }

  pause(): void {
    const active = this.#activePlay;
    if (this.#status !== 'playing' || active === null) return;

    this.#driver.pause();
    this.#stopTimers();
    this.#status = 'paused';
    this.#setBuffering(false);
    this.#reportElapse(active);

    const song = this.activeSong();
    if (song !== null) this.#emitter.emit('play-paused', song);
  }

  resume(): void {
    const active = this.#activePlay;
    if (this.#status !== 'paused' || active === null) return;

    this.#status = 'playing';
    const generation = this.#generation;
    void this.#driver.play().catch((error: unknown) => {
      if (generation !== this.#generation) return;
      // Generation alone does not identify the song: #advance() and skip()
      // move to a new song without bumping it. Only revert if this is still
      // the same song this resume() started, and it is still marked playing
      // (a later pause()/teardown() already resolved things correctly).
      if (this.#activePlay !== active || this.#status !== 'playing') return;
      // The dominant cause here is browser autoplay policy, not a bad play —
      // the play is left intact so a later user gesture can retry it.
      this.#status = 'paused';
      this.#stopTimers();
      this.#emitError(error);
      const song = this.activeSong();
      if (song !== null) this.#emitter.emit('play-paused', song);
    });
    this.#startTimers();

    const song = this.activeSong();
    if (song !== null) this.#emitter.emit('play-started', song);
  }

  /**
   * The server decides. A `false` here means keep playing: ending the song
   * anyway would breach the licensing protocol.
   */
  async skip(): Promise<boolean> {
    const active = this.#activePlay;
    if (active === null || !active.started) return false;

    const generation = this.#generation;

    try {
      const granted = await this.#client.skipPlay(active.play.id, this.#driver.currentTime());
      if (!granted) return false;
      if (generation !== this.#generation) return true;

      this.#status = 'playing';
      // Issued, not awaited. #advance() promotes the standby synchronously,
      // but it then waits on driver.play(), whose promise settles only when
      // audio actually begins — so awaiting it here would leave skip()
      // pending for as long as the next song takes to load, or forever if it
      // stalls. The caller is waiting on the skip decision, which is in.
      void this.#advance(generation, { complete: false });
      return true;
    } catch (error) {
      this.#emitError(error);
      return false;
    }
  }

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
