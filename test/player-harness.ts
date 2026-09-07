import { vi } from 'vitest';
import { PlayerImpl } from '../src/player/player.js';
import type { ApiStation, Play, SearchPlay } from '../src/api/schema.js';
import type { FeedApiClient } from '../src/api/client.js';
import type { PlayerEvents } from '../src/types.js';
import { FakeAudioDriver } from './fake-audio-driver.js';

export const NOW = 1_800_000_000_000;

export function apiStation(overrides: Partial<ApiStation> = {}): ApiStation {
  return {
    id: '7', uuid: 'u-7', name: 'Pop', on_demand: 0, pre_gain: null,
    options: {}, crossfade_seconds: 0, single_play: 0, last_updated: 'x', ...overrides,
  };
}

export function makePlay(id: string, url = `https://cdn/${id}.mp3`): Play {
  return {
    id,
    audio_file: {
      id: `af-${id}`, duration_in_seconds: 180, codec: 'mp3', url,
      track: { id: 't', title: `Song ${id}` },
      release: { id: 'r', title: 'Album' },
      artist: { id: 'a', name: 'Artist' },
      extra: {},
    },
  };
}

export function makeSearchPlay(id: string, station = apiStation(), url?: string): SearchPlay {
  return { ...makePlay(id, url), station };
}

export function makePlayer(stations = [{ uuid: 'u-7', id: '7', name: 'Pop', options: {} }]) {
  const client = {
    clientId: 'cid',
    searchStation: vi.fn(),
    // Defaults resolve to a usable play so a test that does not care about the
    // next-song preload does not fail inside it.
    createPlay: vi.fn(async () => makePlay('default')),
    startPlay: vi.fn(async (_playId: string) => ({ canSkip: true, canLike: true })),
    elapsePlay: vi.fn(async () => undefined),
    skipPlay: vi.fn(async () => true),
    completePlay: vi.fn(async () => undefined),
    invalidatePlay: vi.fn(async () => undefined),
    post: vi.fn(),
  };

  const driver = new FakeAudioDriver();
  const events: Array<{ name: keyof PlayerEvents; arg?: unknown }> = [];

  const player = new PlayerImpl({
    client: client as unknown as FeedApiClient,
    driver,
    clientId: 'cid',
    stations,
    now: () => NOW,
  });

  const names: Array<keyof PlayerEvents> = [
    'play-started', 'play-elapsed', 'play-paused', 'play-stopped',
    'buffering-started', 'buffering-ended', 'error',
  ];
  for (const name of names) {
    player.on(name, ((arg: unknown) => { events.push({ name, arg }); }) as never);
  }

  const eventNames = () => events.map((e) => e.name);

  return { player, client, driver, events, eventNames };
}
