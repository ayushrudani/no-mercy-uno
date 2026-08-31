/**
 * HTTP surface: authentication, profile and match history.
 *
 * Everything that happens during a game goes over the socket instead. REST is
 * only for the things that must work before a socket exists.
 */

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { displayNameSchema, profileUpdateSchema, roomCodeSchema } from '@nmu/shared';
import { AuthError, SESSION_COOKIE, signSession, verifyGoogleIdToken, verifySession } from './auth/tokens.js';
import { recentMatchesFor, updateProfile, upsertUserFromGoogle, db } from './db.js';
import { env } from './env.js';
import { buildIceServers, hasTurn } from './voice/ice.js';
import type { RoomManager } from './rooms/RoomManager.js';

const googleLoginSchema = z.object({ idToken: z.string().min(16).max(8192) });

export interface HttpDeps {
  rooms: RoomManager;
}

/** Session token from the cookie, falling back to an Authorization header. */
function tokenFrom(req: FastifyRequest): string | null {
  const cookieToken = req.cookies[SESSION_COOKIE];
  if (cookieToken) return cookieToken;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

async function requireUserId(req: FastifyRequest): Promise<string> {
  const token = tokenFrom(req);
  if (!token) throw new AuthError('not signed in');
  const { userId } = await verifySession(token);
  return userId;
}

export async function buildHttpServer(deps: HttpDeps): Promise<FastifyInstance> {
  const config = env();
  const app = Fastify({
    logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug' },
    trustProxy: true,
  });

  await app.register(cookie);
  await app.register(cors, { origin: config.corsOrigins, credentials: true });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AuthError) {
      return reply.code(401).send({ code: 'unauthorized', message: err.message });
    }
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ code: 'bad_request', message: err.issues[0]?.message ?? 'bad request' });
    }
    app.log.error(err);
    return reply.code(500).send({ code: 'internal', message: 'something went wrong' });
  });

  app.get('/api/config', async () => ({
    googleClientId: config.GOOGLE_CLIENT_ID,
    devAuth: config.NODE_ENV === 'development',
  }));

  app.get('/api/health', async () => ({
    ok: true,
    rooms: deps.rooms.size,
    uptime: Math.round(process.uptime()),
  }));

  /**
   * Exchange a Google ID token for our own session.
   *
   * The browser gets the ID token from Google Identity Services; we verify it
   * against Google's JWKS, then issue a session of our own. The cookie is
   * httpOnly so page scripts cannot read it, and the token is also returned in
   * the body because the socket handshake needs to send it explicitly.
   */
  app.post('/api/auth/google', async (req, reply) => {
    const { idToken } = googleLoginSchema.parse(req.body);
    const identity = await verifyGoogleIdToken(idToken);
    const user = await upsertUserFromGoogle(identity);
    const token = await signSession(user.id);

    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.NODE_ENV === 'production',
      path: '/',
      maxAge: config.SESSION_TTL_DAYS * 24 * 60 * 60,
    });

    return { token, user: publicProfile(user) };
  });

  /**
   * Development-only sign-in, so the app can be run and played before a Google
   * OAuth client exists.
   *
   * Registered ONLY when NODE_ENV is development. In production this route does
   * not exist at all -- it is not a flag that can be flipped by a stray env
   * var, the handler is never attached.
   */
  if (config.NODE_ENV === 'development') {
    app.log.warn('DEV AUTH ENABLED: POST /api/auth/dev creates accounts without a password');

    app.post('/api/auth/dev', async (req, reply) => {
      const { name } = z.object({ name: displayNameSchema }).parse(req.body);
      const sub = `dev:${name.toLowerCase()}`;
      const user = await db().user.upsert({
        where: { googleSub: sub },
        update: { lastSeenAt: new Date() },
        create: { googleSub: sub, email: `${sub}@dev.local`, displayName: name },
      });
      const token = await signSession(user.id);
      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        path: '/',
        maxAge: config.SESSION_TTL_DAYS * 24 * 60 * 60,
      });
      return { token, user: publicProfile(user) };
    });
  }

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    const userId = await requireUserId(req);
    const user = await db().user.findUnique({ where: { id: userId } });
    if (!user) throw new AuthError('account no longer exists');
    return { user: publicProfile(user) };
  });

  app.patch('/api/me', async (req) => {
    const userId = await requireUserId(req);
    const patch = profileUpdateSchema.parse(req.body);
    const user = await updateProfile(userId, patch);
    return { user: publicProfile(user) };
  });

  app.get('/api/me/matches', async (req) => {
    const userId = await requireUserId(req);
    const matches = await recentMatchesFor(userId);
    return { matches };
  });

  /**
   * Does this room exist, and is it joinable? Lets the join screen say "no such
   * room" before asking for a password. Deliberately does not reveal the member
   * list or settings to someone who has not authenticated into the room.
   */
  app.get('/api/rooms/:code', async (req) => {
    await requireUserId(req);
    const { code } = z.object({ code: roomCodeSchema }).parse(req.params);
    const room = deps.rooms.get(code);
    if (!room) return { exists: false };
    const view = room.view();
    return {
      exists: true,
      status: view.status,
      name: view.settings.name,
      players: view.members.length,
      maxPlayers: view.settings.maxPlayers,
    };
  });

  /**
   * Fresh ICE servers, including short-lived TURN credentials.
   *
   * Authenticated: TURN relays real bandwidth, so credentials go only to a
   * signed-in user. Fetched per call rather than baked into /api/config
   * because the credentials expire.
   */
  app.get('/api/voice/ice', async (req) => {
    const userId = await requireUserId(req);
    return { iceServers: buildIceServers(userId), hasTurn: hasTurn() };
  });

  // In production the same process serves the built client, so there is one
  // origin, no CORS in the request path, and one thing to deploy.
  if (config.WEB_DIST) {
    await app.register(fastifyStatic, { root: config.WEB_DIST, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/socket.io')) {
        return reply.code(404).send({ code: 'not_found', message: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}

type UserRow = {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  cardBack: string;
  sfxVolume: number;
  micDefaultOn: boolean;
  preferredTurnSeconds: number;
};

function publicProfile(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    cardBack: user.cardBack,
    sfxVolume: user.sfxVolume,
    micDefaultOn: user.micDefaultOn,
    preferredTurnSeconds: user.preferredTurnSeconds,
  };
}
