import { describe, expect, it } from 'vitest';
import { toPublicStation, toStationRecord } from '../src/player/stations.js';
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
