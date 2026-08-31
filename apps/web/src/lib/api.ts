/**
 * REST calls. Only the things that must work before a socket exists:
 * discovering how to sign in, signing in, and reading your profile.
 */

export interface Profile {
  id: string;
  username: string;
  /** True until the signup password has been replaced. */
  mustResetPassword: boolean;
  displayName: string;
  avatarUrl: string | null;
  handSort: string;
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
  signupEnabled: boolean;
  minPasswordLength: number;
}

/**
 * What every auth route returns.
 *
 * `mustResetPassword` decides what the token is worth: when it is true the
 * token only authorises `resetPassword`, and the app must show the new-password
 * screen rather than storing it as a session.
 */
export interface AuthResult {
  token: string;
  mustResetPassword: boolean;
  user: Profile;
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
    ...init,
    // Merged, not replaced: the reset call needs to add an Authorization
    // header without losing the content type its body depends on.
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
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

  signUp: (input: { username: string; password: string; code: string; displayName?: string }) =>
    request<AuthResult>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  signIn: (username: string, password: string) =>
    request<AuthResult>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  /**
   * Spend a reset token on a new password.
   *
   * The token goes in an Authorization header rather than a cookie: a reset
   * token is not a session and is deliberately never stored as one, so it only
   * exists in memory between the login screen and this call.
   */
  resetPassword: (resetToken: string, newPassword: string) =>
    request<AuthResult>('/api/auth/reset-password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resetToken}` },
      body: JSON.stringify({ newPassword }),
    }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ token: string; user: Profile }>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  signOut: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  updateProfile: (patch: Partial<Pick<Profile, 'displayName' | 'handSort' | 'cardBack' | 'sfxVolume' | 'micDefaultOn' | 'preferredTurnSeconds'>>) =>
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
