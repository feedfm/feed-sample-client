# Plan

Let's make a plan to create a new typescript SDK package  that can be used to
retrieve and play music from feed.fm in a browser.

The feed.fm API is documented in https://feed.fm/api/v3/openapi.yaml

Let's call this SDK 'feed-sample-client`. This package will let the client
initiate a session with the Feed.fm API using client provided credentials, and
then allow the client to search for and play available stations. The SDK must
only allow playback of a single station at a time - starting playback of a new
station must immediately stop any playback already in progress.

## Basic Signature

The package should export, at the very top level, a method called `connect` that
requires a token and secret value and an optional `clientId`. This method should
return a `Player` object if it is able to make a successful `POST /session`
query to feed.fm the response indicates music is available to the client, or it
throw an error. If no `clientId` value is passed to the method, it should look
for a value it previously placed in local storage. If no value is found in local
stored, it should not send a `clientId` as part of the query, and it should save
the returned client id to local storage for future calls.

The client can use the returned `Player` object to search for and play `Station`
objects. The signature for `Player` is:

```typescript
interface Player {

  /**
   * Return client id associated with this session.
   */

  clientId(): string;

  /**
   * Return the status of the player. The player is 'stopped' by 
   * default. It is 'playing' after a call to `play` or `resume`. It is
   * 'paused' after a call to `pause`.
   */
  
  status(): "stopped" | "playing" | "paused"

  /**
   * Returns 'true' if the player is in the 'playing' status
   * but is waiting for a network response and unable to play audio.
   */

  buffering(): boolean;

  /**
   * Returns metadata about the actively playing song, including the
   * title, artist, release, total song duration, and elapsed duration.
   */

  activeSong(): SongMetadata | null;

  /**
   * Return the default stations for this session - the subset the server
   * returns up front so a client need not fetch the placement's full station
   * list on startup. This is not every station the credentials can play.
   * Stable for the life of the player, and empty when none were returned.
   */

  defaultStations(): Station[];

  /**
   * Prepare the audio elements for playback without requiring a station.
   * Browsers only permit audio that a user gesture initiated, and an awaited
   * `findStation` spends that gesture, so a caller invokes this synchronously
   * from a click or tap and then plays whenever the station resolves. Safe to
   * call repeatedly; `play` unlocks as well.
   */

  unlockAudio(): void;

  /**
   * Search for a station on the server and return a Station object
   * that can be passed to `play` to begin playback. If the search
   * query matches no station, then return null.
   **/

  findStation(query: string): Promise<Station | null>;

  /**
   * If the player is not already playing or pausing the given station, 
   * stop any existing playback and then begin playback of music
   * from the given station. Music playback will continue until
   * the server stops returning music or the client calls `pause`
   * or `stop` or `play` with a new station.
   * 
   * If the player was paused with the given station, then just
   * resume playback.
   */

  play(station: Station): void;

  /**
   * Pause playback of the current song in the current station.
   */

  pause(): void;

  /**
   * Resume playback of the most recently paused song.
   **/

  resume(): void;

  /**
   * Ask the server if the currently playing song may be skipped.
   * Advance to the next song if the skip is granted, otherwise don't
   * do anything. The returned boolean will be true if the song was
   * approved and false otherwise.
   **/
   
  skip(): Promise<boolean>;

  /**
   * Stop playback of the current song. After this call, `resume`
   * has no effect, and the caller must call `play` again to start
   * music playback.
   */

  stop(): void;

}
```

The `Station` objects returned by `findStation` must identify stations by their
`uuid` and never by their numeric station id:

```typescript
interface Station {

  /**
   * The station's uuid. This is the only station identifier the SDK exposes.
   * The numeric station id returned by the API must be held internally and
   * must never appear on a `Station` object, in an event payload, or in an
   * error message.
   */

  uuid: string;

  /**
   * The station's display name. This is editable display text, so it must
   * not be used to identify a station - use `uuid` for that.
   */

  name: string;

  /**
   * Customer-configured station options, passed through as-is.
   */

  options: Record<string, unknown>;

}
```

## Additional Behavior

The Player object should, internally, hold an `activeStation` object that holds
the Station that the client has requested to play. The Player
should hold 'activePlay' and 'nextPlay' objects that represent the song
actively playing and the next song that will be played on completion of the
active song.

The player should use the `POST /station` call to search for stations for the
client. For now, just do an exact search by passing the `q` API parameter as:

```json
[
  { 
    "filter": {
      "name": "${query}"
    }
  }
]
```

where `${query}` is the string passed to this `findStation` method. The response 
from that call should be used by the `play()` method as the first song to play.

The SDK needs the numeric station id internally to make `POST /play` calls, but
it must keep that value private and never place it on a `Station` object handed
to the client. Where the SDK holds no internal record for a station - a
`Station` that came from a different `Player` instance, say - it must locate the
station again by searching on `uuid` rather than by id.

The Player instance must ensure that only a single stream of music is playing
at any given time, and it will hold authentication and session data. 

The Player object should be an event emitter, so that clients can be notified
of events via simple `player.on('event-name', () => { ... })`. Events to emit 
are:

- playback of a song has started or resumed
- playback has elapsed at least one second
- playback has stopped
- playback has been paused
- the player is trying to play audio, but is waiting on a network request
- the play has resumed audio playback after waiting on a network request
- an error has occurred, which possibly stopped playback

When `pause` or `stop` is called, the player should send a `POST
/play/{play_id}/elapse` call to the server to report how much the
user has played.

Use `https://stage.feed.fm/` as the base API url rather than `https://feed.fm/`
when doing real end-to-end testing.
