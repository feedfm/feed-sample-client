import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStoredClientId, writeStoredClientId } from '../src/storage.js';

function installStorage(impl: Partial<Storage>): void {
  vi.stubGlobal('localStorage', impl as Storage);
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('client id storage', () => {
  it('scopes the key by token so two credential pairs do not collide', () => {
    const store = new Map<string, string>();
    installStorage({
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => { store.set(k, v); },
    });

    writeStoredClientId('tok-a', 'client-a');
    writeStoredClientId('tok-b', 'client-b');

    expect(store.get('feed.fm.client_id.tok-a')).toBe('client-a');
    expect(readStoredClientId('tok-a')).toBe('client-a');
    expect(readStoredClientId('tok-b')).toBe('client-b');
  });

  it('returns undefined when nothing is stored', () => {
    installStorage({ getItem: () => null, setItem: () => undefined });
    expect(readStoredClientId('tok')).toBeUndefined();
  });

  // Private browsing throws on access rather than returning null.
  it('survives a localStorage that throws on read', () => {
    installStorage({
      getItem: () => { throw new Error('blocked'); },
      setItem: () => undefined,
    });
    expect(readStoredClientId('tok')).toBeUndefined();
  });

  it('survives a localStorage that throws on write', () => {
    installStorage({
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
    });
    expect(() => writeStoredClientId('tok', 'client')).not.toThrow();
  });

  it('survives localStorage being absent entirely', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(readStoredClientId('tok')).toBeUndefined();
    expect(() => writeStoredClientId('tok', 'client')).not.toThrow();
  });
});
