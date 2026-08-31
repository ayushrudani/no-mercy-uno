/**
 * REST calls. Only the things that must work before a socket exists:
 * discovering how to sign in, signing in, and reading your profile.
 */

export interface Profile {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  cardBack: string;
  sfxVolume: number;
  micDefaultOn: boolean;
  preferredTurnSeconds: number;
}

/** One row from GET /api/me/matches. */
export interface MatchSummary {
  id: string;
  roomCode: string;
  startedAt: string;
  endedAt: string | null;
  rounds: number;
  winnerId: string | null;
  players: {
    userId: string;
    seat: number;
    roundsWon: number;
    finalPlace: number | null;
    user: { id: string; displayName: string; avatarUrl: string | null };
  }[];
}

export interface AppConfig {
  googleClientId: string;
  devAuth: boolean;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: init.body ? { 'Content-Type': 'application/json' } : {},
    ...init,
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
    throw new ApiError(body?.code ?? 'internal', body?.message ?? res.statusText, res.status);
  }
  return res.json() as Promise<T>;
}

export const api = {
  config: () => request<AppConfig>('/api/config'),

  me: () => request<{ user: Profile }>('/api/me'),

  signInWithGoogle: (idToken: string) =>
    request<{ token: string; user: Profile }>('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ idToken }),
    }),

  /** Development only; the route does not exist in a production build. */
  signInAsDev: (name: string) =>
    request<{ token: string; user: Profile }>('/api/auth/dev', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  signOut: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  updateProfile: (patch: Partial<Pick<Profile, 'displayName' | 'cardBack' | 'sfxVolume' | 'micDefaultOn' | 'preferredTurnSeconds'>>) =>
    request<{ user: Profile }>('/api/me', { method: 'PATCH', body: JSON.stringify(patch) }),

  matches: () => request<{ matches: MatchSummary[] }>('/api/me/matches'),

  /** Short-lived TURN credentials; fetched per call because they expire. */
  iceServers: () =>
    request<{ iceServers: RTCIceServer[]; hasTurn: boolean }>('/api/voice/ice'),

  lookupRoom: (code: string) =>
    request<
      | { exists: false }
      | { exists: true; status: string; name: string; players: number; maxPlayers: number }
    >(`/api/rooms/${code.toUpperCase()}`),
};

// The session token is also kept in localStorage because the socket handshake
// has to present it explicitly -- the httpOnly cookie is unreadable by design.
const TOKEN_KEY = 'nmu.token';

export const tokenStore = {
  get: (): string | null => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (token: string): void => {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* private mode; the session simply will not survive a refresh */
    }
  },
  clear: (): void => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  },
};
