import { FeedApiClient } from './api/client.js';
import { HtmlAudioDriver } from './audio/html-audio.js';
import { ErrorCode, FeedError } from './errors.js';
import { PlayerImpl } from './player/player.js';
import { hasUsableUuid, toStationRecord } from './player/stations.js';
import { readStoredClientId, writeStoredClientId } from './storage.js';
import type { ConnectOptions, Player } from './types.js';

interface InternalConnectOptions extends ConnectOptions {
  fetchImpl?: typeof fetch;
}

export async function connect(options: ConnectOptions): Promise<Player> {
  const { token, secret, baseUrl } = options;
  const { fetchImpl } = options as InternalConnectOptions;

  const client = new FeedApiClient({ token, secret, baseUrl, fetchImpl });

  const requestedClientId = options.clientId ?? readStoredClientId(token);
  const response = await client.startSession(requestedClientId);
  const session = response.session;

  if (!session.available) {
    throw new FeedError(
      ErrorCode.noMusic,
      session.message ?? 'No streaming music is available for this client',
      403,
    );
  }

  client.clientId = session.client_id;
  writeStoredClientId(token, session.client_id);

  return new PlayerImpl({
    client,
    driver: new HtmlAudioDriver(),
    clientId: session.client_id,
    // A seeded station only saves a lookup later, so skip any the SDK cannot
    // address rather than failing the session over it. The loud failure belongs
    // at findStation, where a caller actually asks for a station to play.
    stations: (response.stations ?? []).filter(hasUsableUuid).map(toStationRecord),
  });
}
