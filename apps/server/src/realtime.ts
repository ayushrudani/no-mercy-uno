/**
 * Socket.IO wiring.
 *
 * Three rules hold throughout:
 *  1. Every inbound payload is parsed with zod before it reaches a Room.
 *  2. The acting user comes from the verified session on the socket, never
 *     from the payload -- otherwise anyone could play a card "as" someone else.
 *  3. Game state leaves only through Room.broadcastGame, which redacts per
 *     player. Nothing here ever emits a raw GameState.
 */

import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import {
  chatSendSchema,
  createRoomSchema,
  joinRoomSchema,
  playCardSchema,
  reactSchema,
  rouletteColorSchema,
  roomSettingsSchema,
  swapTargetSchema,
  targetUserSchema,
  voiceSignalSchema,
  voiceStateSchema,
  type Ack,
  type ClientToServerEvents,
  type ErrorCode,
  type ServerToClientEvents,
  type SocketData,
} from '@nmu/shared';
import { AuthError, verifySession } from './auth/tokens.js';
import { db } from './db.js';
import { env } from './env.js';
import { RoomError, type Room } from './rooms/Room.js';
import type { RoomManager } from './rooms/RoomManager.js';

type NmuServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type NmuSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

const ok = <T>(data: T): Ack<T> => ({ ok: true, data });
const fail = (code: ErrorCode, message: string): Ack<never> => ({ ok: false, error: { code, message } });

/** Personal channel, so a redacted game state reaches one player only. */
const userChannel = (userId: string) => `user:${userId}`;
const roomChannel = (code: string) => `room:${code}`;

export function createTransport(io: NmuServer) {
  return {
    toRoom(code: string, event: string, ...args: unknown[]) {
      (io.to(roomChannel(code)).emit as (e: string, ...a: unknown[]) => void)(event, ...args);
    },
    toUser(userId: string, event: string, ...args: unknown[]) {
      (io.to(userChannel(userId)).emit as (e: string, ...a: unknown[]) => void)(event, ...args);
    },
  } as const;
}

/**
 * Wrap a handler so any RoomError becomes a structured ack rather than an
 * unhandled rejection that silently drops the client's callback.
 */
function guard<T>(ack: ((r: Ack<T>) => void) | undefined, fn: () => Promise<T> | T): void {
  void (async () => {
    try {
      const data = await fn();
      ack?.(ok(data));
    } catch (err) {
      if (err instanceof RoomError) return ack?.(fail(err.code, err.message));
      if (err instanceof z.ZodError) {
        return ack?.(fail('bad_request', err.issues[0]?.message ?? 'bad request'));
      }
      console.error('[socket] handler failed', err);
      ack?.(fail('internal', 'something went wrong'));
    }
  })();
}

export function attachRealtime(httpServer: HttpServer, rooms: RoomManager): NmuServer {
  const config = env();

  const io: NmuServer = new Server(httpServer, {
    cors: { origin: config.corsOrigins, credentials: true },
    // Generous, because a phone on mobile data will stall briefly and we would
    // rather hold the seat than drop the player mid-hand.
    pingInterval: 10_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 128 * 1024,
  });

  // --- Authentication -------------------------------------------------------
  io.use(async (socket, next) => {
    try {
      const raw = socket.handshake.auth as { token?: unknown };
      if (typeof raw.token !== 'string') throw new AuthError('missing session token');
      const { userId, scope } = await verifySession(raw.token);
      // A reset token proves identity but authorises only the password change.
      // Sockets are the whole game, so nothing less than a session gets one.
      if (scope !== 'session') throw new AuthError('set a new password before playing');

      const user = await db().user.findUnique({
        where: { id: userId },
        select: { id: true, displayName: true, avatarUrl: true, mustResetPassword: true },
      });
      if (!user) throw new AuthError('account no longer exists');
      if (user.mustResetPassword) throw new AuthError('set a new password before playing');

      socket.data.userId = user.id;
      socket.data.displayName = user.displayName;
      socket.data.roomCode = null;
      next();
    } catch (err) {
      next(err instanceof Error ? err : new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    void socket.join(userChannel(userId));

    // A player may have refreshed mid-game; put them straight back at the table.
    const existing = rooms.findByUser(userId);
    if (existing) {
      void rejoin(socket, existing);
    }

    registerRoomHandlers(socket, rooms);
    registerGameHandlers(socket, rooms);
    registerChatHandlers(socket, rooms);
    registerVoiceHandlers(socket, rooms);

    socket.on('net:ping', (ack) => ack?.(Date.now()));

    socket.on('disconnect', () => {
      const room = currentRoom(socket, rooms);
      if (!room) return;
      // Only drop them if this was their last socket -- a second tab closing
      // must not mark someone offline at the table.
      void io
        .in(userChannel(userId))
        .fetchSockets()
        .then((remaining) => {
          if (remaining.length === 0) room.markDisconnected(userId);
        });
    });
  });

  return io;
}

// ---------------------------------------------------------------------------

async function rejoin(socket: NmuSocket, room: Room): Promise<void> {
  await socket.join(roomChannel(room.code));
  socket.data.roomCode = room.code;
  room.join(profileOf(socket));
}

function profileOf(socket: NmuSocket) {
  return {
    userId: socket.data.userId,
    displayName: socket.data.displayName,
    avatarUrl: null as string | null,
  };
}

function currentRoom(socket: NmuSocket, rooms: RoomManager): Room | null {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) ?? null : null;
}

function requireRoom(socket: NmuSocket, rooms: RoomManager): Room {
  const room = currentRoom(socket, rooms);
  if (!room) throw new RoomError('not_in_room', 'you are not in a room');
  return room;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function registerRoomHandlers(socket: NmuSocket, rooms: RoomManager): void {
  const userId = socket.data.userId;

  socket.on('room:create', (input, ack) =>
    guard(ack, async () => {
      const { settings, password } = createRoomSchema.parse(input);
      const profile = await profileWithAvatar(socket);
      const room = await rooms.create(profile, settings, password);
      await socket.join(roomChannel(room.code));
      socket.data.roomCode = room.code;
      room.broadcastRoom();
      return { code: room.code };
    }),
  );

  socket.on('room:join', (input, ack) =>
    guard(ack, async () => {
      const { code, password } = joinRoomSchema.parse(input);
      const profile = await profileWithAvatar(socket);
      const room = await rooms.join(code, password, profile);
      await socket.join(roomChannel(room.code));
      socket.data.roomCode = room.code;
      return { code: room.code };
    }),
  );

  socket.on('room:leave', (ack) =>
    guard(ack, async () => {
      const room = requireRoom(socket, rooms);
      room.leave(userId);
      await socket.leave(roomChannel(room.code));
      socket.data.roomCode = null;
      return null;
    }),
  );

  socket.on('room:settings', (input, ack) =>
    guard(ack, () => {
      requireRoom(socket, rooms).updateSettings(userId, roomSettingsSchema.parse(input));
      return null;
    }),
  );

  socket.on('room:kick', (input, ack) =>
    guard(ack, () => {
      requireRoom(socket, rooms).kick(userId, targetUserSchema.parse(input).userId);
      return null;
    }),
  );

  socket.on('room:transferHost', (input, ack) =>
    guard(ack, () => {
      requireRoom(socket, rooms).transferHost(userId, targetUserSchema.parse(input).userId);
      return null;
    }),
  );

  socket.on('room:start', (ack) =>
    guard(ack, () => {
      requireRoom(socket, rooms).start(userId);
      return null;
    }),
  );
}

function registerGameHandlers(socket: NmuSocket, rooms: RoomManager): void {
  const userId = socket.data.userId;

  socket.on('game:play', (input, ack) =>
    guard(ack, () => {
      const { cardId, color } = playCardSchema.parse(input);
      requireRoom(socket, rooms).applyAction(userId, {
        t: 'play',
        playerId: userId,
        cardId,
        ...(color ? { color } : {}),
      });
      return null;
    }),
  );

  socket.on('game:draw', (ack) =>
    guard(ack, () => {
      requireRoom(socket, rooms).applyAction(userId, { t: 'draw', playerId: userId });
      return null;
    }),
  );

  socket.on('game:pass', (ack) =>
    guard(ack, () => {
      requireRoom(socket, rooms).applyAction(userId, { t: 'pass', playerId: userId });
      return null;
    }),
  );

  socket.on('game:rouletteColor', (input, ack) =>
    guard(ack, () => {
      const { color } = rouletteColorSchema.parse(input);
      requireRoom(socket, rooms).applyAction(userId, {
        t: 'chooseRouletteColor',
        playerId: userId,
        color,
      });
      return null;
    }),
  );

  socket.on('game:callUno', (ack) =>
    guard(ack, () => {
      requireRoom(socket, rooms).applyAction(userId, { t: 'callUno', playerId: userId });
      return null;
    }),
  );

  socket.on('game:swapTarget', (input, ack) =>
    guard(ack, () => {
      const { targetId } = swapTargetSchema.parse(input);
      requireRoom(socket, rooms).applyAction(userId, {
        t: 'chooseSwapTarget',
        playerId: userId,
        targetId,
      });
      return null;
    }),
  );
}

function registerChatHandlers(socket: NmuSocket, rooms: RoomManager): void {
  const userId = socket.data.userId;

  socket.on('chat:send', (input, ack) =>
    guard(ack, () => {
      const { text } = chatSendSchema.parse(input);
      requireRoom(socket, rooms).chat(userId, text);
      return null;
    }),
  );

  socket.on('chat:react', (input, ack) =>
    guard(ack, () => {
      const { reaction } = reactSchema.parse(input);
      requireRoom(socket, rooms).react(userId, reaction);
      return null;
    }),
  );
}

/**
 * WebRTC signalling relay.
 *
 * The server never sees or touches the audio -- it only forwards opaque SDP and
 * ICE blobs, and only between two people who are demonstrably in the same room.
 * That last check is what stops a signed-in stranger from spraying offers at
 * someone else's game.
 */
function registerVoiceHandlers(socket: NmuSocket, rooms: RoomManager): void {
  const userId = socket.data.userId;

  socket.on('voice:join', (ack) =>
    guard(ack, () => ({ userIds: requireRoom(socket, rooms).joinVoice(userId) })),
  );

  socket.on('voice:leave', (ack) =>
    guard(ack, () => {
      requireRoom(socket, rooms).leaveVoice(userId);
      return null;
    }),
  );

  socket.on('voice:state', (input) => {
    const parsed = voiceStateSchema.safeParse(input);
    const room = currentRoom(socket, rooms);
    if (!parsed.success || !room) return;
    room.setMic(userId, parsed.data.micOn);
  });

  for (const kind of ['offer', 'answer', 'ice'] as const) {
    socket.on(`voice:${kind}`, (input) => {
      const parsed = voiceSignalSchema.safeParse(input);
      const room = currentRoom(socket, rooms);
      if (!parsed.success || !room) return;
      if (!room.canSignal(userId, parsed.data.to)) return;
      socket.to(userChannel(parsed.data.to)).emit(`voice:${kind}`, {
        from: userId,
        data: parsed.data.data,
      });
    });
  }
}

async function profileWithAvatar(socket: NmuSocket) {
  const user = await db().user.findUnique({
    where: { id: socket.data.userId },
    select: { id: true, displayName: true, avatarUrl: true },
  });
  return {
    userId: socket.data.userId,
    displayName: user?.displayName ?? socket.data.displayName,
    avatarUrl: user?.avatarUrl ?? null,
  };
}
