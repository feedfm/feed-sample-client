export interface Track { id: string; title: string; }
export interface Release { id: string; title: string; }
export interface Artist { id: string; name: string; }

export interface AudioFile {
  id: string;
  duration_in_seconds: number;
  codec: string;
  url?: string;
  bitrate?: number;
  track: Track;
  release: Release;
  artist: Artist;
  extra: Record<string, unknown>;
  liked?: true;
  can_seek?: true;
  can_cache?: true;
  preview?: true;
  replaygain_track_gain?: number;
}

/** Stamped onto plays. Carries no uuid — see spec §2. */
export interface MinimalStation { id: string; name: string; pre_gain?: number | null; }

export interface ApiStation {
  id: string;
  uuid: string;
  name: string;
  on_demand: number | boolean;
  pre_gain: number | null;
  options: Record<string, unknown>;
  crossfade_seconds: number;
  single_play: number | boolean;
  last_updated: string;
}

export interface Play { id: string; audio_file: AudioFile; start_at?: number; station?: MinimalStation; }
export interface SearchPlay { id: string; audio_file: AudioFile; start_at?: number; station: ApiStation; }

export interface Session {
  available: boolean;
  client_id: string;
  time: number;
  message?: string;
}

export interface SessionResponse {
  success: boolean;
  session: Session;
  placement?: { id: string; options: Record<string, unknown> };
  stations?: ApiStation[];
}

export interface StationSearchQuery {
  type?: 'radio' | 'first_play' | 'replay';
  filter?: Record<string, unknown>;
  at?: number;
}

export interface FeedErrorBody {
  success: false;
  error: { code: number; message: string; status: number };
}
