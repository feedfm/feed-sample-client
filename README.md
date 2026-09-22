# feed-sample-client

## Purpose

This repository contains an example browser SDK that uses the Feed.fm API
to play music. This code was created by Anthropic Claude by passing it the the included
`PROMPT.md` file. Claude produced the `SPEC.md` file, which was then implemented
in typescript. This example meant to guide Feed.fm customers looking to make their
own SDK for their own platforms.

This a very minimal implementation. There is an additional `crossfade` branch
that extends on this implementation to support crossfading between songs. Also,
clients may extend this to make use of `like` and `skip` functionality, which
isn't included in this demo.

## Overview

This is a browser SDK for playing music from Feed.fm. Start a session, find a station
by name, play it.

```bash
npm install feed-sample-client
```

## Usage

```typescript
import { connect } from 'feed-sample-client';

const player = await connect({ token: 'demo', secret: 'demo' });

player.on('play-started', (song) => {
  console.log(`${song.title} — ${song.artist}`);
});

// Safari and iOS only allow audio to start inside the synchronous call stack
// of a user gesture, and an awaited findStation() spends that gesture. Call
// unlockAudio() synchronously from the click, then play whenever the station
// resolves.
document.querySelector('#play')!.addEventListener('click', async () => {
  player.unlockAudio();

  const station = await player.findStation('Station One');
  if (station !== null) player.play(station);
});
```

## connect(options)

| Option | Required | Meaning |
| --- | --- | --- |
| `token` | yes | Your Feed.fm token |
| `secret` | yes | Your Feed.fm secret |
| `clientId` | no | Reuse a known listener. Falls back to `localStorage`, then to a server-minted id |
| `baseUrl` | no | Defaults to `https://feed.fm`. Use `https://stage.feed.fm` for staging |

Rejects with a `FeedError` if the credentials are refused or the client has no
music available.

## Player

| Method | Returns | Notes |
| --- | --- | --- |
| `clientId()` | `string` | The listener id this session is bound to |
| `status()` | `'stopped' \| 'playing' \| 'paused'` | `'playing'` from the moment `play()` is called |
| `buffering()` | `boolean` | Playing, but waiting on the network |
| `activeSong()` | `SongMetadata \| null` | Title, artist, release, duration, elapsed |
| `defaultStations()` | `Station[]` | The session's up-front subset, not the full catalog. Stable for the player's life |
| `unlockAudio()` | `void` | Prepare audio inside a user gesture, before a station is known. Optional; `play()` unlocks too |
| `findStation(query)` | `Promise<Station \| null>` | Exact name match; `null` when nothing playable matches |
| `play(station)` | `void` | Stops any other station first. Resumes if this station is paused |
| `pause()` / `resume()` | `void` | |
| `skip()` | `Promise<boolean>` | `false` when the server denies the skip; playback continues |
| `stop()` | `void` | After this, `resume()` does nothing — call `play()` again |

Stations are identified by `uuid`. `name` is display text and may be edited.

## Events

```typescript
player.on('play-started',      (song) => {});  // started or resumed
player.on('play-elapsed',      (song) => {});  // once per second
player.on('play-paused',       (song) => {});
player.on('play-stopped',      ({ reason }) => {});  // 'ended' | 'stopped-by-caller' | 'superseded' | 'error'
player.on('buffering-started', () => {});
player.on('buffering-ended',   () => {});
player.on('error',             (err) => {});   // FeedError — see Errors below
```

A station running out of music emits `play-stopped` with reason `'ended'`, not
an `error`.

## Errors

`FeedError` carries a `code` (number), a `mnemonic` (the name for that code) and
a `status` (the HTTP status the failure maps to — not necessarily the status
the HTTP response actually carried; some failures the API reports as HTTP 200
with `success: false` are mapped to a representative status instead). `code`
is the stable value to branch on; `message` is free text that varies by call
site and isn't meant for `switch` statements.

`ErrorCode` is exported so you can compare against named codes instead of
magic numbers:

```typescript
import { ErrorCode, FeedError } from 'feed-sample-client';

player.on('error', (err) => {
  if (err.code === ErrorCode.throttled) return; // back off; the client is sending too many requests
  console.error(`${err.mnemonic} (${err.code}): ${err.message}`);
});

try {
  await connect({ token: 'demo', secret: 'demo' });
} catch (err) {
  if (err instanceof FeedError && err.code === ErrorCode.noMusic) {
    // this client has no playable music
  }
}
```

Two codes are the SDK's own rather than the API's, and are negative to keep
them distinct: `networkError` (-1) for a request that never returned a usable
response, and `malformedResponse` (-2) for one that parsed but carried data the
SDK cannot act on. The latter is what `findStation` rejects with when a station
arrives without a `uuid` — stations are addressed by uuid alone, so accepting
one without would make it indistinguishable from every other station, and
`play()` would silently do nothing. Failing there is deliberate.

A skip that the server denies (`skipDenied`, 7, or `playNotActive`, 12) never
reaches `error` — `skip()` resolves `false` and playback continues instead.

## Notes

- One `Player` plays one station at a time. `play()` on a new station stops the
  current one.
- Playback reporting is a licensing requirement. The SDK reports starts,
  completions and elapsed time on your behalf; a denied skip never stops the
  current song.
- `connect` takes a consumer token and secret, which ships the secret to the
  browser. For production, mint a short-lived pair with `POST /access_token`
  server-side and pass that instead — it uses the same scheme, so nothing else
  changes. Note that `FeedApiClient` computes its `Authorization` header once,
  in the constructor, and never rotates it, so a short-lived pair only remains
  valid for sessions shorter than the token's own lifetime — reconnect (or
  otherwise refresh the pair) before it expires.
