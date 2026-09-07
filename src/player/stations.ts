import type { ApiStation } from '../api/schema.js';
import type { Station } from '../types.js';
import { ErrorCode, FeedError } from '../errors.js';

/** Internal only. Holds the numeric id the API needs for POST /play. */
export interface StationRecord {
  uuid: string;
  id: string;
  name: string;
  options: Record<string, unknown>;
}

/**
 * Whether a station carries an identifier the SDK can address it by. The API
 * documents `uuid` as required, but a server that omits it would make every
 * station compare equal to every other, so callers check before converting.
 */
export function hasUsableUuid(station: ApiStation): boolean {
  return typeof station.uuid === 'string' && station.uuid !== '';
}

/**
 * @throws {FeedError} when the station has no usable uuid. Failing here is
 * deliberate: stations are addressed by uuid alone, so accepting one without
 * makes it indistinguishable from every other station - `play()` would treat a
 * new station as the one already playing and silently do nothing.
 */
export function toStationRecord(station: ApiStation): StationRecord {
  if (!hasUsableUuid(station)) {
    throw new FeedError(
      ErrorCode.malformedResponse,
      `Station "${station.name}" arrived without a uuid, so it cannot be addressed`,
      200,
    );
  }

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
