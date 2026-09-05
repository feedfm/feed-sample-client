# feed-sample-client — design

Date: 2026-09-04
Status: approved, ready for implementation planning
Source requirements: `PROMPT.md`
API reference: `/Users/ericlambrecht/git/feed-api/openapi/spec.v3.yml` (Feed Media Group Streaming API v3)

## 1. Purpose and scope

A TypeScript SDK that lets browser code start a Feed.fm session with customer
credentials, search for a station by name, and play music from it. One stream of
audio at a time, per `Player` instance.

The SDK is responsible for the playback protocol the API requires — reserve,
start, report elapsed time, complete — because that reporting is a licensing
obligation rather than analytics. It is not responsible for any UI.

### Non-goals

Deliberately out of scope, and not to be added speculatively:

- like / dislike / unlike
- offline placements and offline stations
- minting or revoking access tokens (`POST /access_token`)
- crossfade, seeking, `at` offsets, on-demand playback by `audio_file_id`
- `pre_gain` / `replaygain_track_gain` volume normalization (would need WebAudio)
- station listing and paging (`GET /station`), placement selection
- `POST /session/event`
- volume control, playlists, queue inspection

## 2. Public API

```typescript
export function connect(options: ConnectOptions): Promise<Player>;

export interface ConnectOptions {
  token: string;
  secret: string;
  clientId?: string;
  baseUrl?: string;
}

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
  'error': (error: FeedError) => void;
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

export class FeedError extends Error {
  readonly code: number;       // Feed error code, e.g. 9
  readonly mnemonic: string;   // e.g. 'noMoreMusic'
  readonly status: number;     // HTTP status the failure maps to
}
```

`connect` resolves to a `Player`, or rejects with a `FeedError`.

### Station identity

`uuid` is the only station identifier the SDK exposes. The numeric station id is
held internally and must never appear on a `Station`, in an event payload, or in
an error message. The public object is constructed fresh with exactly the three
public fields — it is not the internal record with a property omitted from the
type — so `JSON.stringify(station)` cannot leak the id.

The API's `MinimalStation`, stamped onto every play returned by `POST /play`, is
`{ id, name, pre_gain }` and carries **no uuid**. A public `Station` therefore can
never be derived from a play. The uuid arrives only on the full `Station` schema,
which means `POST /station` (as `play.station`) and the `stations` array on
`POST /session`. Enforce that one-way rule in code.

## 3. Package and tooling

- Build: `tsup`, emitting ESM + CJS + `.d.ts`.
- Unit tests: `vitest`, node environment.
- Browser tests: `playwright`, chromium.
- Zero runtime dependencies. The typed emitter is written in-repo.

```
feed-sample-client/
  package.json
  tsconfig.json
  tsup.config.ts
  vitest.config.ts
  playwright.config.ts
  src/
    index.ts              connect(), public re-exports
    types.ts              Player, Station, SongMetadata, PlayerEvents
    errors.ts             FeedError, code/mnemonic table
    config.ts             constants (TTLs, intervals, limits)
    api/
      client.ts           FeedApiClient
      schema.ts           wire types transcribed from spec.v3.yml
    audio/
      driver.ts           AudioDriver interface
      html-audio.ts       two-HTMLAudioElement implementation
    player/
      player.ts           the state machine
      emitter.ts          typed emitter
      reservations.ts     reservation store and freshness rules
      stations.ts         StationRecord <-> public Station mapping
  test/
    fake-audio-driver.ts
    *.test.ts
  e2e/
    harness/index.html
    player.spec.ts
```

## 4. Module boundaries

**`FeedApiClient`** — one method per endpoint. Holds credentials and client id
and nothing else. It has no knowledge of playback state.

Its job beyond transport is collapsing the API's two error channels into one. An
HTTP 4xx/5xx carrying an error envelope and an HTTP 200 carrying
`success: false` both surface as the same `FeedError`, so `noMoreMusic` (9),
`skipDenied` (7), `playNotActive` (12) and `formatUnavailable` (24) are handled
by code once rather than by status line at every call site.

**`AudioDriver`** — the only module that touches the DOM. Everything above it is
testable in node against a fake.

**`Player`** — the state machine. Depends on `FeedApiClient` and `AudioDriver`
through their interfaces.

## 5. Transport and auth

- Base URL defaults to `https://feed.fm`; `/api/v3` is appended. A trailing
  slash on `baseUrl` is normalized away.
- Auth header is `Authorization: Basic base64(token:secret)`. Verified against
  `https://stage.feed.fm`: the CORS preflight for `POST /api/v3/session` returns
  `access-control-allow-headers: authorization,content-type`, so the
  `X-Authorization` fallback documented for constrained environments is not
  needed here.
- `client_id` is sent as a body property on every POST.
- `formats` is not sent, so the API default of `mp3` applies. Universally
  supported in browsers, and it keeps `formatUnavailable` (24) unlikely.

## 6. Error model

`FeedError` carries `code`, `mnemonic`, `status`. The client normalizes three
inputs into it: an HTTP error with a JSON envelope, an HTTP 200 with
`success: false`, and a network or parse failure (synthetic code).

How failures reach the caller:

| Surface | Behavior |
| --- | --- |
| `connect` | rejects with `FeedError` |
| `findStation` | rejects for real failures; resolves `null` for codes 17, 9, 24 |
| `skip` | never rejects — resolves `false`, emits `error` for genuine failures |
| `play` / `pause` / `resume` / `stop` | `void`; everything routes to the `error` event |

`findStation` resolving `null` for `noMoreMusic` and `formatUnavailable` is
deliberate: a station with nothing playable behind it is, from the caller's
side, a station they cannot play.

### Recovery paths

Two failures get real handling rather than an event and a shrug:

1. **Audio fails to load.** `POST /play/{id}/invalidate` with a reason, then
   reserve a fresh play and retry. This is one of only two places the SDK
   invalidates rather than discards (see §9): without it, `POST /play` returns
   the same broken play and the retry loops on a dead file. Capped at
   `MAX_CONSECUTIVE_PLAY_FAILURES` (3), after which the player stops with reason
   `'error'` and emits `error`.

2. **`POST /play` fails.** One retry with backoff on 5xx and network errors
   only, never on 4xx. Failures accumulate toward the code-22 throttle
   (10 errors in 5 minutes), so retrying into a throttle makes it worse. A
   `throttled` (22) response stops the player and emits `error`.

## 7. Audio driver

```typescript
export type AudioEvent = 'ended' | 'timeupdate' | 'waiting' | 'playing' | 'error';

export interface AudioDriver {
  loadCurrent(url: string, startAt?: number): void;
  loadStandby(url: string, startAt?: number): void;
  hasStandby(): boolean;
  promoteStandby(): void;
  play(): Promise<void>;
  pause(): void;
  stop(): void;
  unlock(): void;
  currentTime(): number;
  on(event: AudioEvent, handler: (payload?: unknown) => void): void;
  destroy(): void;
}
```

The HTML implementation holds two `HTMLAudioElement`s, `current` and `standby`,
so the next song preloads while the current one plays; `promoteStandby` swaps
them, which is how playback advances without a gap.

Browser behavior the driver must absorb:

- `audio.play()` rejects with `NotAllowedError` outside a user gesture, and the
  standby element has never seen one. `unlock()` — a `play()` immediately
  followed by `pause()` on both elements — runs on the first gesture-driven
  `play()` so the standby element is usable when it is promoted.
- `start_at` on a play is applied by setting `currentTime` once metadata loads.
- DOM events map to `AudioEvent` as: `ended`; `timeupdate`; `waiting` and
  `stalled` to `waiting`; `playing` to `playing`; `error`. Note that `canplay`
  is deliberately **not** mapped to `playing`: it fires when playback could
  begin, not when it has, and `POST /play/{id}/start` must report the moment
  audio actually reaches the listener.
- `hasStandby()` means the standby element has a source loaded and a
  `readyState` of at least `HAVE_CURRENT_DATA`, not merely that a URL was
  assigned. A standby that has not buffered is treated as absent, so the
  advance path falls through to its buffering branch instead of promoting an
  element that will immediately stall.

## 8. Player state

```typescript
status: PlayerStatus
buffering: boolean
activeStation: StationRecord | null
activePlay: { play: Play; started: boolean; canSkip: boolean } | null
nextPlay: Play | null
generation: number
consecutiveFailures: number
playsStartedCount: number
```

Per `PROMPT.md`, `status` becomes `'playing'` the moment `play()` is called,
before any network work. `buffering` is what reports that audio is not yet
coming out. `buffering` is only ever true while `status === 'playing'`.

### The generation guard

`play()` returns `void` but does async work, so `play(a); play(b)` leaves
in-flight requests for `a` that must not land. Every method that changes what is
playing — `play`, `stop`, and the advance inside `skip` — increments
`generation`. Every async continuation captures the value it started under and
re-checks it after each `await`, abandoning its work if it moved.

This is the mechanism that enforces the single-stream requirement. Without it, a
slow `POST /play` for an abandoned station will start audio a second after the
caller switched away.

### Timers

Two, not one:

- 1s tick, emitting `play-elapsed`.
- 10s tick, posting `POST /play/{id}/elapse`.

Both run only while `status === 'playing'`, and both stop on pause and stop.

## 9. Reservations

`POST /station` does not merely find a station — it reserves a play, whose audio
URL is a CloudFront signature expiring in roughly 20 minutes, and which the spec
declares invalid if another play is started before it. So `findStation` has a
side effect that has to be managed.

```typescript
interface Reservation {
  play: SearchPlay;
  reservedAt: number;
  startedCountAtReserve: number;
}

reservations: Map<uuid, Reservation>
stations: Map<uuid, StationRecord>
```

A reservation is fresh when both hold:

- `Date.now() - reservedAt < RESERVATION_TTL_MS` (15 minutes, leaving margin
  against the ~20 minute URL expiry), and
- `startedCountAtReserve === playsStartedCount` — no other play has been started
  since, which is the condition the spec names directly.

Consumption and cleanup:

**An unused play is discarded, not invalidated.** Dropping the reference is
enough — no `POST /play/{id}/invalidate` call, no request at all. So:

- `play()` uses a fresh reservation and removes it from the map.
- `stop()` discards `nextPlay`.
- Tearing down to switch stations discards the outgoing station's `nextPlay`.
- A second `findStation` for the same station replaces the reservation and
  discards the old one.

Discarding is not merely acceptable in these cases, it is slightly better than
invalidating: an unstarted play stays in the client's queue, so the next
`POST /play` for that station hands the same song back, and a listener who
returns to a station resumes where they were rather than losing a track.

### The two cases that must still invalidate

`POST /play` returns the *same* play until that play is either started or
invalidated. Verified against stage: three consecutive `POST /play` calls for
one station all returned play `122059400751373`; after
`POST /play/{id}/invalidate` the next call returned a different play. The
response is byte-identical across repeats, so a re-fetch does not re-sign the
audio URL either.

`invalidate` is therefore not a courtesy to the server. It is the only lever
that produces a *different* play, which makes it load-bearing in exactly two
places:

1. **A play whose audio failed to load.** Discard it and the retry receives the
   identical broken play, fails again, and loops until the failure cap kills the
   station. Invalidating moves past the bad transcode, which is the entire point
   of the call.
2. **A reservation that has aged past `RESERVATION_TTL_MS`.** Its signed URL is
   near or past expiry, and re-fetching returns the same play with the same URL.
   Invalidating is the only way to obtain a playable one.

Everywhere else, discard.

### Station without an internal record

For a `Station` whose uuid is not in `stations` — one from a different `Player`
instance, or one that round-tripped through storage — there is no numeric id to
reserve with. It is located again by search:

```json
{ "q": [ { "filter": { "uuid": "<uuid>" } } ] }
```

The spec names `uuid` as the stable way to address exactly one station, `name`
being editable display text. Its result populates `stations` and `reservations`,
after which the flow proceeds normally.

## 10. Flows

### connect(options)

1. Resolve client id: `options.clientId`, else
   `localStorage['feed.fm.client_id.' + token]`, else send none.
2. `POST /session` with `{ client_id }` when one is known.
3. Reject on request failure, or when `session.available === false` — which
   arrives as HTTP 200 with `success: true`, so it must be checked explicitly.
   The rejection carries `session.message`.
4. Persist `session.client_id` under the token-scoped key. Every localStorage
   read and write is wrapped in try/catch, since private-browsing modes throw on
   access rather than returning null.
5. Seed `stations` from the `stations` array on the response — these are full
   `Station` objects and carry uuids.
6. Construct the `Player`.

The key is scoped per token so a page using two credential pairs does not hand
one client's history to the other.

### findStation(query)

1. `POST /station` with `{ client_id, q: [{ filter: { name: query } }] }`.
2. On success, record the `StationRecord` and the `Reservation` from
   `play.station` and `play`, and return the public `Station`.
3. `missingObject` (17), `noMoreMusic` (9), `formatUnavailable` (24) resolve
   `null`.
4. Anything else rejects.

This method never touches playback state, so it is safe to call mid-song.

### play(station)

1. If `activeStation?.uuid === station.uuid`: resume when `'paused'`, no-op when
   `'playing'`, fall through when `'stopped'`.
2. Otherwise tear down: stop audio, `POST elapse` for `activePlay` if it was
   started, discard `nextPlay`, clear state, emit `play-stopped` with reason
   `'superseded'`.
3. Increment `generation`. Set `activeStation`, `status = 'playing'`,
   `buffering = true`, emit `buffering-started`. Call `driver.unlock()`.
4. Obtain a play: fresh reservation, else `POST /play { station_id }`, else the
   uuid search described in §9.
5. `loadCurrent(url, start_at)` and `driver.play()`.
6. When audio genuinely starts (`playing` event): fire
   `POST /play/{id}/start` **without blocking audio on it**, record `can_skip`,
   increment `playsStartedCount`, and start both timers. If `buffering` was
   true, set it false and emit `buffering-ended`. Then emit `play-started`.
   `buffering-ended` is emitted only when a `buffering-started` preceded it, so
   an advance that promotes an already-buffered standby emits neither.
7. Immediately after issuing `start`, reserve the next song via
   `POST /play { station_id }` and `loadStandby` it. The spec recommends exactly
   this overlap, and it is what makes advancing gapless.

Steps 4 through 7 re-check `generation` after every `await`.

### Advancing (song end, or granted skip)

1. On `ended`: `POST /play/{id}/complete`. On a granted skip: no `complete` —
   the skip already closed the play out.
2. If `hasStandby()`, `promoteStandby()` and continue from step 6 above.
3. If not, set `buffering = true`, emit `buffering-started`, reserve and load.
4. If no play can be reserved because of `noMoreMusic` (9), stop cleanly with
   reason `'ended'`: `status = 'stopped'`, emit `play-stopped`, no `error`
   event. Running out of music is the end of a station, not a failure.

### pause / resume

`pause` applies only while `'playing'`: pause audio, stop both timers,
`POST elapse` with the current position, `status = 'paused'`, emit
`play-paused`. `activePlay`, `nextPlay` and `activeStation` are all retained.

`resume` applies only while `'paused'`: resume audio, restart timers,
`status = 'playing'`, emit `play-started`. After `stop()` it is a no-op, because
`activePlay` is gone.

### skip

1. No `activePlay`, or not yet started: resolve `false`.
2. `POST /play/{id}/skip { client_id, seconds }`.
3. `skipDenied` (7) or `playNotActive` (12): resolve `false`, keep playing,
   emit nothing. The spec is blunt that stopping the song without a granted skip
   risks credential revocation, so a denial is never treated as an error.
4. Success: advance per above, resolve `true`.

`can_skip` from the start response is stored but does not gate the call. The
spec says it is advisory and the cap is re-evaluated when the skip is actually
requested, and `PROMPT.md` says to ask the server.

### stop

No-op when already `'stopped'`. Otherwise: stop audio, `POST elapse` for
`activePlay` if started, discard `nextPlay`, clear `activePlay`, `nextPlay`
and `activeStation`, stop timers, `status = 'stopped'`, `buffering = false`,
increment `generation`, emit `play-stopped` with reason `'stopped-by-caller'`.
The only network call `stop()` makes is the `elapse`.

`stop` never calls `complete`, because the song did not finish. `elapse` reports
what was actually heard.

## 11. Testing

### Unit — API client

`FeedApiClient` against mocked `fetch`. Every endpoint, and for each endpoint
that has one, its HTTP-200-with-`success: false` case. Plus 401, 403, 404, 429,
malformed JSON, and network failure.

### Unit — state machine

`FakeAudioDriver` and a mocked client, in node, with no real time:

- play, pause, resume, stop
- `play(b)` while `a` plays: reports elapse for `a`, tears it down, emits
  `play-stopped` with reason `'superseded'` before `play-started`
- `play(activeStation)` while paused resumes rather than restarting
- `resume()` after `stop()` does nothing
- skip denied keeps playing and resolves `false`
- skip granted advances without calling `complete`
- song end calls `complete` and promotes the preloaded standby
- `noMoreMusic` stops with reason `'ended'` and emits no `error`
- a stale reservation is invalidated and re-reserved
- `stop()` issues an `elapse` and no `invalidate`
- switching stations discards the outgoing `nextPlay` without any request
- a second `findStation` for one station discards the prior reservation silently
- a station with no internal record is located by uuid search
- audio load failure invalidates and retries, and stops after 3
- a late response from a superseded `play()` is dropped by the generation guard
- events fire in the documented order
- leak guard: serialized `Station`s, event payloads and `FeedError` messages
  contain no numeric station id

### Browser — Playwright

A harness page loads the built bundle against `https://stage.feed.fm`.
Credentials: `counting:counting` for completion logic, since those tracks are a
few seconds long, and `demo:demo` for search.

Covers: connect succeeds and persists the client id; `findStation` returns a
real station; playback starts and `play-started` fires; a track completes and
advances; skip; pause and resume; stop.

Assertions read the SDK's own events *and* the network calls, so a track that
completes without a `complete` request fails the test. Playback is started by a
real button click, since autoplay policy requires the gesture.

## 12. Constants

| Name | Value |
| --- | --- |
| `RESERVATION_TTL_MS` | 900_000 (15 min) |
| `ELAPSE_INTERVAL_MS` | 10_000 |
| `TICK_INTERVAL_MS` | 1_000 |
| `MAX_CONSECUTIVE_PLAY_FAILURES` | 3 |
| `DEFAULT_BASE_URL` | `https://feed.fm` |
| `CLIENT_ID_STORAGE_PREFIX` | `feed.fm.client_id.` |

## 13. Decisions recorded

Choices made during brainstorming, with the reasoning, so they are not silently
revisited:

- **Reservations are attached and freshness-checked**, rather than always reused
  or always discarded. Honors `PROMPT.md`'s "use the search result as the first
  song" while staying safe against a ~20 minute URL expiry.
- **`connect` takes a single options object.** Deviates from the positional
  signature in `PROMPT.md` in order to give `baseUrl` an obvious home, which
  end-to-end testing against stage requires.
- **Elapse is reported every 10 seconds plus on pause and stop.** `PROMPT.md`
  asks only for pause and stop; the API docs ask for every 10–30 seconds so a
  disappearing tab still reports correctly. Both are satisfied.
- **Running out of music stops cleanly with a reason**, and emits no `error`.
  `play-stopped` carries `'ended'` versus `'stopped-by-caller'` so a UI can tell
  them apart.
- **Event names are explicit kebab-case** (`play-started`, `buffering-started`)
  rather than mirroring DOM audio event names, so no reader assumes DOM
  semantics the SDK does not guarantee.
- **Unused plays are discarded, never invalidated**, except for a play whose
  audio failed to load and a reservation past its TTL. Measured against stage:
  `POST /play` returns the same play until it is started or invalidated, so in
  those two cases discarding produces a retry loop on the same unplayable song,
  while everywhere else it saves a request and lets a listener return to a
  station without losing a track.
- **`Authorization`, not `X-Authorization`**, verified by preflight against
  stage.
- **Layered modules with an explicit status union**, rather than a single class
  or an `xstate` machine. The `AudioDriver` seam is what makes the sequencing —
  which is where all the risk lives — testable without a browser.

## 14. Known risk carried forward

`connect` takes a consumer token and secret, which means shipping the secret to
the browser. The API's own answer to this is `POST /access_token`, which mints a
short-lived pair server-side. `PROMPT.md` specifies token and secret, so that is
what is built; because access tokens use the identical `basicAuth` scheme,
`connect` works unchanged if a short-lived pair is passed instead. Worth
flagging to anyone who takes this sample toward production.
