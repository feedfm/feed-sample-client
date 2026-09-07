import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect } from '../src/connect.js';
import { FeedError } from '../src/errors.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const availableSession = {
  success: true,
  session: { available: true, client_id: 'minted-1', time: 1 },
  stations: [{
    id: '7', uuid: 'u-7', name: 'Pop', on_demand: 0, pre_gain: null,
    options: {}, crossfade_seconds: 0, single_play: 0, last_updated: 'x',
  }],
};

function installStorage(store = new Map<string, string>()) {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
  } as unknown as Storage);
  return store;
}

class FakeAudioElement {
  src = '';
  preload = '';
  currentTime = 0;
  readyState = 0;
  play = async () => undefined;
  pause = () => undefined;
  load = () => undefined;
  removeAttribute = () => { this.src = ''; };
  addEventListener = () => undefined;
}

function installAudio(): void {
  vi.stubGlobal('Audio', FakeAudioElement);
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('connect', () => {
  it('sends no client_id on a first connect and persists the minted one', async () => {
    const store = installStorage();
    installAudio();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      jsonResponse(availableSession));

    const player = await connect({ token: 'tok', secret: 'sec', fetchImpl } as never);

    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({});
    expect(player.clientId()).toBe('minted-1');
    expect(store.get('feed.fm.client_id.tok')).toBe('minted-1');
  });

  it('reuses a client id from storage when none is passed', async () => {
    installStorage(new Map([['feed.fm.client_id.tok', 'stored-9']]));
    installAudio();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      jsonResponse(availableSession));

    await connect({ token: 'tok', secret: 'sec', fetchImpl } as never);

    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ client_id: 'stored-9' });
  });

  it('prefers an explicit clientId over storage', async () => {
    installStorage(new Map([['feed.fm.client_id.tok', 'stored-9']]));
    installAudio();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      jsonResponse(availableSession));

    await connect({ token: 'tok', secret: 'sec', clientId: 'explicit-3', fetchImpl } as never);

    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ client_id: 'explicit-3' });
  });

  // available:false arrives as HTTP 200 with success:true. Status alone is a lie.
  it('rejects when the session reports no music available', async () => {
    installStorage();
    installAudio();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      jsonResponse({
        success: true,
        session: { available: false, client_id: 'c', time: 1, message: 'Sorry, no music' },
      }));

    const promise = connect({ token: 'tok', secret: 'sec', fetchImpl } as never);

    await expect(promise).rejects.toBeInstanceOf(FeedError);
    await expect(promise).rejects.toMatchObject({ message: 'Sorry, no music' });
  });

  it('rejects on bad credentials', async () => {
    installStorage();
    installAudio();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      jsonResponse({ success: false, error: { code: 5, message: 'bad creds', status: 401 } }, 401));

    await expect(connect({ token: 'tok', secret: 'sec', fetchImpl } as never))
      .rejects.toMatchObject({ code: 5 });
  });

  it('uses the supplied baseUrl', async () => {
    installStorage();
    installAudio();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      jsonResponse(availableSession));

    await connect({ token: 'tok', secret: 'sec', baseUrl: 'https://stage.feed.fm', fetchImpl } as never);

    expect(fetchImpl.mock.calls[0]![0]).toBe('https://stage.feed.fm/api/v3/session');
  });
});

describe('connect with an unusable station in the session', () => {
  // The session's `stations` array is an optimization - it saves a lookup
  // later. One malformed entry must not cost the whole session; the loud
  // failure belongs at findStation, where a caller actually asks for it.
  it('skips a seeded station with no uuid instead of failing the session', async () => {
    installStorage();
    installAudio();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      jsonResponse({
        success: true,
        session: { available: true, client_id: 'c1', time: 1 },
        stations: [
          { id: '7', uuid: null, name: 'Broken', on_demand: 0, pre_gain: null,
            options: {}, crossfade_seconds: 0, single_play: 0, last_updated: 'x' },
          { id: '8', uuid: 'u-8', name: 'Fine', on_demand: 0, pre_gain: null,
            options: {}, crossfade_seconds: 0, single_play: 0, last_updated: 'x' },
        ],
      }));

    const player = await connect({ token: 'tok', secret: 'sec', fetchImpl } as never);

    expect(player.clientId()).toBe('c1');
  });
});
