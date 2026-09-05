import type { Play, SearchPlay } from '../api/schema.js';
import { RESERVATION_TTL_MS, URL_EXPIRY_MARGIN_SECONDS } from '../config.js';
import { urlExpiry } from '../url-expiry.js';

export interface Reservation {
  play: Play | SearchPlay;
  reservedAt: number;
  startedCountAtReserve: number;
}

/**
 * A reservation is usable when no other play has been started since it was
 * made — the condition the API spec names — and its audio URL has not expired.
 *
 * Expiry is read from the URL's `Expires` parameter where there is one. Where
 * there is not (stage serves unsigned URLs) we fall back to how long ago the
 * play was reserved, rather than assuming the worst and re-fetching forever.
 */
export function isReservationFresh(
  reservation: Reservation,
  playsStartedCount: number,
  nowMs: number,
): boolean {
  if (reservation.startedCountAtReserve !== playsStartedCount) return false;

  const url = reservation.play.audio_file.url;
  if (url === undefined) return false;

  switch (urlExpiry(url, URL_EXPIRY_MARGIN_SECONDS, nowMs)) {
    case 'valid':
      return true;
    case 'expired':
      return false;
    case 'unknown':
      return nowMs - reservation.reservedAt < RESERVATION_TTL_MS;
  }
}

export class ReservationStore {
  readonly #byStationUuid = new Map<string, Reservation>();

  put(uuid: string, reservation: Reservation): void {
    // Replacing simply drops the old one. An unused play needs no invalidate.
    this.#byStationUuid.set(uuid, reservation);
  }

  take(uuid: string): Reservation | undefined {
    const reservation = this.#byStationUuid.get(uuid);
    this.#byStationUuid.delete(uuid);
    return reservation;
  }

  discard(uuid: string): void {
    this.#byStationUuid.delete(uuid);
  }
}
