# feed-sample-client

A browser SDK for playing music from Feed.fm. Start a session, find a station
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

// Call play() from a click handler: browsers only allow audio to start
// from a user gesture.
document.querySelector('#play')!.addEventListener('click', async () => {
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
a `status` (the HTTP status from the request that failed). `code` is the
stable value to branch on; `message` is free text that varies by call site and
isn't meant for `switch` statements.

`ErrorCode` is exported so you can compare against named codes instead of
magic numbers:

```typescript
import { ErrorCode, FeedError } from 'feed-sample-client';

player.on('error', (err) => {
  if (err.code === ErrorCode.skipDenied) return; // playback continues
  console.error(`${err.mnemonic} (${err.code}): ${err.message}`);
});

try {
  await connect({ token: 'demo', secret: 'demo' });
} catch (err) {
  if (err instanceof FeedError && err.code === ErrorCode.noMoreMusic) {
    // this client has no playable music
  }
}
```

## Notes

- One `Player` plays one station at a time. `play()` on a new station stops the
  current one.
- Playback reporting is a licensing requirement. The SDK reports starts,
  completions and elapsed time on your behalf; a denied skip never stops the
  current song.
- `connect` takes a consumer token and secret, which ships the secret to the
  browser. For production, mint a short-lived pair with `POST /access_token`
  server-side and pass that instead — it uses the same scheme, so nothing else
  changes.
