import { z } from 'zod';

/**
 * Environment is validated once, at boot, and the process refuses to start if
 * anything is missing. A server that comes up healthy and then fails to verify
 * a Google token an hour later is far worse than one that will not start.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().min(1).default('file:./dev.db'),

  /**
   * OAuth client id from Google Cloud Console; also the ID-token audience.
   *
   * Optional. Left empty, the Google button simply does not render and the
   * only way in is the development sign-in -- which is the right trade for a
   * private game among friends who do not want to set up OAuth.
   */
  GOOGLE_CLIENT_ID: z.string().default(''),

  /** Signing key for our own session tokens. Must be >= 32 chars. */
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  /** Comma-separated browser origins allowed to call the API and open sockets. */
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  /** Directory of built client assets to serve. Unset in development. */
  WEB_DIST: z.string().optional(),

  // --- Voice ---------------------------------------------------------------
  /** Comma-separated STUN URLs. Google's public servers are a fine default. */
  STUN_URLS: z
    .string()
    .default('stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'),
  /** Comma-separated TURN URLs, e.g. turn:uno.bunkcode.online:3478. */
  TURN_URLS: z.string().default(''),
  /** Shared secret matching coturn's `static-auth-secret`. */
  TURN_SECRET: z.string().default(''),
  /** How long an issued TURN credential stays valid. */
  TURN_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),

  /** Seconds a disconnected player keeps their seat before being dropped. */
  RECONNECT_GRACE_SECONDS: z.coerce.number().int().min(10).max(600).default(120),
  /** Idle minutes before an empty or abandoned room is reclaimed. */
  ROOM_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(180),
});

export type Env = z.infer<typeof schema> & { corsOrigins: string[] };

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  const corsOrigins = parsed.data.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { ...parsed.data, corsOrigins };
}

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}
