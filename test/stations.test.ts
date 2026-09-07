import { describe, expect, it } from 'vitest';
import { toPublicStation, toStationRecord } from '../src/player/stations.js';
import { ErrorCode, FeedError } from '../src/errors.js';
import type { ApiStation } from '../src/api/schema.js';

const apiStation: ApiStation = {
  id: '33714093',
  uuid: 'u-abc',
  name: 'Station One',
  on_demand: 1,
  pre_gain: 12,
  options: { genre: 'pop' },
  crossfade_seconds: 0,
  single_play: 0,
  last_updated: '2026-01-01',
};

describe('station mapping', () => {
  it('keeps the numeric id on the internal record', () => {
    expect(toStationRecord(apiStation)).toEqual({
      uuid: 'u-abc',
      id: '33714093',
      name: 'Station One',
      options: { genre: 'pop' },
    });
  });

  it('exposes only uuid, name and options publicly', () => {
    const station = toPublicStation(toStationRecord(apiStation));
    expect(Object.keys(station).sort()).toEqual(['name', 'options', 'uuid']);
  });

  // The leak guard: the numeric id must not survive serialization.
  it('never leaks the numeric station id through JSON', () => {
    const serialized = JSON.stringify(toPublicStation(toStationRecord(apiStation)));
    expect(serialized).not.toContain('33714093');
    expect(serialized).not.toContain('"id"');
  });
});

describe('a station the server sent without a uuid', () => {
  // Stage returns `uuid: null` on POST /station. The SDK addresses stations by
  // uuid, so an absent one makes every station compare equal to every other -
  // play() treats a new station as the one already playing and silently does
  // nothing. Refuse the station instead of acting on it.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
  ])('throws when uuid is %s', (_label, uuid) => {
    const station = { ...apiStation, uuid } as unknown as ApiStation;

    expect(() => toStationRecord(station)).toThrow(FeedError);
  });

  it('names the station and the code so the failure is diagnosable', () => {
    const station = { ...apiStation, uuid: null } as unknown as ApiStation;

    expect(() => toStationRecord(station)).toThrow(/Station One/);
    try {
      toStationRecord(station);
    } catch (error) {
      expect((error as FeedError).code).toBe(ErrorCode.malformedResponse);
    }
  });

  it('still accepts a station that has one', () => {
    expect(toStationRecord(apiStation).uuid).toBe('u-abc');
  });
});
