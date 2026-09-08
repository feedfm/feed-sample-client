import { describe, expect, it } from 'vitest';
import { ErrorCode, FeedError } from '../src/errors.js';
import { apiStation, makePlayer, makeSearchPlay } from './player-harness.js';

describe('Player accessors', () => {
  it('reports the client id and starts stopped', () => {
    const { player } = makePlayer();
    expect(player.clientId()).toBe('cid');
    expect(player.status()).toBe('stopped');
    expect(player.buffering()).toBe(false);
    expect(player.activeSong()).toBeNull();
  });
});

describe('findStation', () => {
  it('searches by exact name and returns a uuid-addressed station', async () => {
    const { player, client } = makePlayer();
    client.searchStation.mockResolvedValue(makeSearchPlay('p1', apiStation({ uuid: 'u-9', name: 'Chill' })));

    const station = await player.findStation('Chill');

    expect(client.searchStation).toHaveBeenCalledWith({ filter: { name: 'Chill' } });
    expect(station).toEqual({ uuid: 'u-9', name: 'Chill', options: {} });
  });

  it('never exposes the numeric station id', async () => {
    const { player, client } = makePlayer();
    client.searchStation.mockResolvedValue(makeSearchPlay('p1', apiStation({ id: '33714093' })));

    const station = await player.findStation('Pop');

    expect(JSON.stringify(station)).not.toContain('33714093');
  });

  it('returns null when no station matches', async () => {
    const { player, client } = makePlayer();
    client.searchStation.mockRejectedValue(new FeedError(17, 'No matching station was found', 404));

    await expect(player.findStation('Nope')).resolves.toBeNull();
  });

  it('returns null when the station has nothing playable', async () => {
    const { player, client } = makePlayer();
    client.searchStation.mockRejectedValue(new FeedError(9, 'no more music', 200));
    await expect(player.findStation('Dry')).resolves.toBeNull();

    client.searchStation.mockRejectedValue(new FeedError(24, 'format unavailable', 200));
    await expect(player.findStation('Odd')).resolves.toBeNull();
  });

  it('rejects on a genuine failure', async () => {
    const { player, client } = makePlayer();
    client.searchStation.mockRejectedValue(new FeedError(22, 'throttled', 429));

    await expect(player.findStation('Pop')).rejects.toMatchObject({ code: 22 });
  });

  it('does not disturb playback state', async () => {
    const { player, client, eventNames } = makePlayer();
    client.searchStation.mockResolvedValue(makeSearchPlay('p1'));

    await player.findStation('Pop');

    expect(player.status()).toBe('stopped');
    expect(eventNames()).toEqual([]);
  });
});

describe('findStation when the server omits the uuid', () => {
  // Not a "no such station" case - the station exists but cannot be addressed.
  // Returning null would look identical to no match; a caller would retry
  // forever. Rejecting says what is actually wrong.
  it('rejects rather than resolving null', async () => {
    const { player, client } = makePlayer();
    const play = makeSearchPlay('p1', apiStation());
    (play.station as { uuid: unknown }).uuid = null;
    client.searchStation.mockResolvedValue(play);

    await expect(player.findStation('Pop')).rejects.toMatchObject({
      code: ErrorCode.malformedResponse,
    });
  });
});

describe('defaultStations', () => {
  it('returns the session stations in the order the server sent them', () => {
    const { player } = makePlayer([
      { uuid: 'u-7', id: '7', name: 'Pop', options: { genre: 'pop' } },
      { uuid: 'u-8', id: '8', name: 'Rock', options: {} },
    ]);

    expect(player.defaultStations()).toEqual([
      { uuid: 'u-7', name: 'Pop', options: { genre: 'pop' } },
      { uuid: 'u-8', name: 'Rock', options: {} },
    ]);
  });

  it('is empty when the session returned none', () => {
    expect(makePlayer([]).player.defaultStations()).toEqual([]);
  });

  it('never exposes the numeric station id', () => {
    const { player } = makePlayer([{ uuid: 'u-7', id: '33714093', name: 'Pop', options: {} }]);

    expect(JSON.stringify(player.defaultStations())).not.toContain('33714093');
  });

  // The list describes the session, not everything the player has since seen.
  // A picker rendered from it must not sprout entries as the user searches.
  it('does not grow when findStation resolves another station', async () => {
    const { player, client } = makePlayer();
    client.searchStation.mockResolvedValue(makeSearchPlay('p1', apiStation({ uuid: 'u-9', name: 'Chill' })));

    await player.findStation('Chill');

    expect(player.defaultStations().map((s) => s.name)).toEqual(['Pop']);
  });

  // Callers must not be able to reach into the player's own state.
  it('cannot be mutated by the caller', () => {
    const { player } = makePlayer();

    player.defaultStations().push({ uuid: 'x', name: 'Injected', options: {} });

    expect(player.defaultStations().map((s) => s.name)).toEqual(['Pop']);
  });
});
