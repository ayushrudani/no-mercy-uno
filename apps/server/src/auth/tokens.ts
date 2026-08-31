/**
 * Two token flows, both handled by `jose` -- no extra dependency needed.
 *
 * 1. Inbound: verify a Google ID token against Google's published JWKS.
 *    We do this ourselves rather than pulling in google-auth-library, which
 *    would add a large dependency to repeat what jose already does.
 * 2. Outbound: mint our own short session JWT. The browser holds it and
 *    presents it on every socket connection, which is what makes reconnecting
 *    to your seat mid-game work.
 */

import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { env } from '../env.js';

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_JWKS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');

// Cached across calls: the set refreshes its keys on its own schedule, and
// rebuilding it per login would refetch Google's certs every time.
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function googleKeys() {
  jwks ??= createRemoteJWKSet(GOOGLE_JWKS_URL);
  return jwks;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
  picture: string | null;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Verify a Google ID token and extract the identity we care about. */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(idToken, googleKeys(), {
      issuer: GOOGLE_ISSUERS,
      audience: env().GOOGLE_CLIENT_ID,
    });
    payload = result.payload;
  } catch (err) {
    throw new AuthError(`Google token rejected: ${(err as Error).message}`);
  }

  const sub = typeof payload['sub'] === 'string' ? payload['sub'] : null;
  const email = typeof payload['email'] === 'string' ? payload['email'] : null;
  if (!sub || !email) throw new AuthError('Google token is missing sub or email');

  // An unverified email would let someone claim an address they do not own.
  if (payload['email_verified'] === false) {
    throw new AuthError('Google account email is not verified');
  }

  const name = typeof payload['name'] === 'string' && payload['name'].trim()
    ? payload['name'].trim()
    : email.split('@')[0]!;
  const picture = typeof payload['picture'] === 'string' ? payload['picture'] : null;

  return { sub, email, name, picture };
}

// ---------------------------------------------------------------------------
// Our own session tokens
// ---------------------------------------------------------------------------

const ISSUER = 'no-mercy-uno';
const AUDIENCE = 'no-mercy-uno-client';

function secret(): Uint8Array {
  return new TextEncoder().encode(env().SESSION_SECRET);
}

export interface Session {
  userId: string;
}

export async function signSession(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env().SESSION_TTL_DAYS}d`)
    .sign(secret());
}

export async function verifySession(token: string): Promise<Session> {
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (typeof payload.sub !== 'string') throw new Error('missing subject');
    return { userId: payload.sub };
  } catch (err) {
    throw new AuthError(`session token rejected: ${(err as Error).message}`);
  }
}

export const SESSION_COOKIE = 'nmu_session';
