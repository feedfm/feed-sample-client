import { CLIENT_ID_STORAGE_PREFIX } from './config.js';

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    // Some browsers throw on the property access itself when site data is blocked.
    return undefined;
  }
}

export function readStoredClientId(token: string): string | undefined {
  try {
    return storage()?.getItem(`${CLIENT_ID_STORAGE_PREFIX}${token}`) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeStoredClientId(token: string, clientId: string): void {
  try {
    storage()?.setItem(`${CLIENT_ID_STORAGE_PREFIX}${token}`, clientId);
  } catch {
    // A client id we cannot persist is not worth failing a session over.
  }
}
