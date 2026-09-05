import { describe, expect, it } from 'vitest';
import { ReservationStore, isReservationFresh, type Reservation } from '../src/player/reservations.js';
import type { Play } from '../src/api/schema.js';

const NOW = 1_800_000_000_000;
const nowSeconds = NOW / 1000;

function play(url: string | undefined): Play {
  return {
    id: '1',
    audio_file: {
      id: 'a1',
      duration_in_seconds: 100,
      codec: 'mp3',
      url,
      track: { id: 't', title: 'T' },
      release: { id: 'r', title: 'R' },
      artist: { id: 'ar', name: 'A' },
      extra: {},
    },
  };
}

function reservation(url: string | undefined, overrides: Partial<Reservation> = {}): Reservation {
  return { play: play(url), reservedAt: NOW, startedCountAtReserve: 0, ...overrides };
}

describe('isReservationFresh', () => {
  it('is fresh when Expires is in the future and no play has started since', () => {
    const r = reservation(`https://cdn/a.mp3?Expires=${nowSeconds + 600}`);
    expect(isReservationFresh(r, 0, NOW)).toBe(true);
  });

  it('is stale once another play has been started', () => {
    const r = reservation(`https://cdn/a.mp3?Expires=${nowSeconds + 600}`);
    expect(isReservationFresh(r, 1, NOW)).toBe(false);
  });

  it('is stale when Expires has passed, however recently it was reserved', () => {
    const r = reservation(`https://cdn/a.mp3?Expires=${nowSeconds - 1}`);
    expect(isReservationFresh(r, 0, NOW)).toBe(false);
  });

  // Stage serves unsigned URLs, so absence of Expires falls back to age.
  it('falls back to the age heuristic when there is no Expires', () => {
    const recent = reservation('https://cdn/a.mp3', { reservedAt: NOW - 60_000 });
    const old = reservation('https://cdn/a.mp3', { reservedAt: NOW - 1_000_000 });
    expect(isReservationFresh(recent, 0, NOW)).toBe(true);
    expect(isReservationFresh(old, 0, NOW)).toBe(false);
  });

  it('is stale when the play has no audio url at all', () => {
    expect(isReservationFresh(reservation(undefined), 0, NOW)).toBe(false);
  });
});

describe('ReservationStore', () => {
  it('take returns the reservation and removes it', () => {
    const store = new ReservationStore();
    const r = reservation('https://cdn/a.mp3');
    store.put('u-1', r);

    expect(store.take('u-1')).toBe(r);
    expect(store.take('u-1')).toBeUndefined();
  });

  it('put replaces an existing reservation for the same station', () => {
    const store = new ReservationStore();
    const first = reservation('https://cdn/a.mp3');
    const second = reservation('https://cdn/b.mp3');
    store.put('u-1', first);
    store.put('u-1', second);

    expect(store.take('u-1')).toBe(second);
  });

  it('discard drops a reservation without any request', () => {
    const store = new ReservationStore();
    store.put('u-1', reservation('https://cdn/a.mp3'));
    store.discard('u-1');

    expect(store.take('u-1')).toBeUndefined();
  });
});
