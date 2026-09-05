import type { ApiStation } from '../api/schema.js';
import type { Station } from '../types.js';

/** Internal only. Holds the numeric id the API needs for POST /play. */
export interface StationRecord {
  uuid: string;
  id: string;
  name: string;
  options: Record<string, unknown>;
}

export function toStationRecord(station: ApiStation): StationRecord {
  return {
    uuid: station.uuid,
    id: station.id,
    name: station.name,
    options: station.options ?? {},
  };
}

/**
 * Builds the public object field by field rather than spreading the record and
 * deleting `id`, so the numeric id cannot survive into JSON, a log line, or an
 * event payload.
 */
export function toPublicStation(record: StationRecord): Station {
  return { uuid: record.uuid, name: record.name, options: record.options };
}
