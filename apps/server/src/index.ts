/**
 * Boot: validate env, open the DB, build the HTTP app, attach the socket
 * server to the same listener, start the room sweeper.
 *
 * One process serves the API, the websockets and (in production) the built
 * client, so there is a single thing to deploy and no cross-origin path.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildHttpServer } from './http.js';
import { disconnectDb, saveMatch } from './db.js';
import { env } from './env.js';
import { attachRealtime, createTransport } from './realtime.js';
import { RoomManager } from './rooms/RoomManager.js';
import type { RoomTransport } from './rooms/Room.js';

// A minute, not five: the sweep now also evicts players who never reconnected,
// and a lobby slot held by a ghost for five minutes is long enough to matter.
const SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * Load a local .env if there is one. Node 22 can do this natively, so no
 * dotenv dependency. Real environment variables always win -- in production the
 * process manager supplies them and there is no file to read.
 */
function loadDotEnv(): void {
  const path = resolve(process.cwd(), '.env');
  if (!existsSync(path)) return;
  try {
    process.loadEnvFile(path);
  } catch (err) {
    console.warn('[env] could not read .env:', (err as Error).message);
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = env();

  // The transport needs the socket server, which needs the HTTP server, which
  // needs the room manager. Break the cycle with a late-bound reference.
  let transport: RoomTransport | null = null;
  const lazyTransport: RoomTransport = {
    toRoom: (...args) => transport?.toRoom(...args),
    toUser: (...args) => transport?.toUser(...args),
  };

  const rooms = new RoomManager({
    transport: lazyTransport,
    roomTtlMs: config.ROOM_TTL_MINUTES * 60 * 1000,
    graceMs: config.RECONNECT_GRACE_SECONDS * 1000,
    onMatchFinished: (result) => {
      // Best effort: a database problem must never take down a live room.
      saveMatch(result).catch((err) => console.error('[db] failed to save match', err));
    },
  });

  const app = await buildHttpServer({ rooms });
  await app.listen({ port: config.PORT, host: config.HOST });

  const io = attachRealtime(app.server, rooms);
  transport = createTransport(io) as unknown as RoomTransport;

  const sweeper = setInterval(() => {
    const { roomsRemoved, playersEvicted } = rooms.sweep();
    if (roomsRemoved > 0 || playersEvicted > 0) {
      app.log.info({ roomsRemoved, playersEvicted }, 'swept rooms');
    }
  }, SWEEP_INTERVAL_MS);

  app.log.info(
    { port: config.PORT, env: config.NODE_ENV, origins: config.corsOrigins },
    'no-mercy-uno server ready',
  );

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    clearInterval(sweeper);
    rooms.disposeAll();
    await io.close();
    await app.close();
    await disconnectDb();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('failed to start:', err);
  process.exit(1);
});
