/**
 * Client state and the single socket connection.
 *
 * The store holds only what the server told us. It never computes game rules --
 * `playableCardIds` arrives in the redacted snapshot, so the highlight in the UI
 * and the server's legality check can never disagree.
 */

import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { io, type Socket } from 'socket.io-client';
import type {
  Ack,
  ChatMessage,
  ClientToServerEvents,
  Color,
  ErrorPayload,
  GameEvent,
  GameSnapshot,
  Reaction,
  ReactionMessage,
  RoomSettings,
  RoomView,
  ServerToClientEvents,
} from '@nmu/shared';
import { api, tokenStore, type Profile } from './api.js';
import { loadMutePreference, saveMutePreference, sound } from './sound.js';
import { VoiceEngine, type PeerState } from './voice.js';

type NmuSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface Toast {
  id: number;
  kind: 'error' | 'info';
  text: string;
}

interface State {
  profile: Profile | null;
  connection: ConnectionState;
  /** Round-trip time in ms, or null before the first probe lands. */
  rtt: number | null;

  room: RoomView | null;
  snapshot: GameSnapshot | null;
  /**
   * Narration queue. Each entry carries a monotonic id so an effect fires once
   * per event -- keying off the array itself would replay the whole batch on
   * any unrelated re-render, and miss a repeat of the same event.
   */
  events: { id: number; e: GameEvent }[];
  chat: ChatMessage[];
  reactions: ReactionMessage[];
  toasts: Toast[];

  gameOver: { winnerId: string; standings: string[] } | null;
  muted: boolean;

  // --- voice ---
  voiceOn: boolean;
  micOn: boolean;
  speakerOn: boolean;
  /** Live loudness per user id, for the speaking rings. */
  levels: Record<string, number>;
  voicePeers: PeerState[];
  /** False when the server has no TURN relay configured. */
  hasTurn: boolean;
}

interface Actions {
  setProfile: (p: Profile | null) => void;
  connect: (token: string) => void;
  disconnect: () => void;
  toast: (kind: Toast['kind'], text: string) => void;
  dismissToast: (id: number) => void;

  createRoom: (settings: RoomSettings, password: string) => Promise<string>;
  joinRoom: (code: string, password: string) => Promise<string>;
  leaveRoom: () => Promise<void>;
  updateSettings: (settings: RoomSettings) => Promise<void>;
  startGame: () => Promise<void>;
  kick: (userId: string) => Promise<void>;
  transferHost: (userId: string) => Promise<void>;

  play: (cardId: string, color?: Color) => Promise<void>;
  draw: () => Promise<void>;
  pass: () => Promise<void>;
  chooseRouletteColor: (color: Color) => Promise<void>;
  chooseSwapTarget: (targetId: string) => Promise<void>;
  callUno: () => Promise<void>;

  sendChat: (text: string) => Promise<void>;
  react: (reaction: Reaction) => Promise<void>;
  signOut: () => Promise<void>;
  setMuted: (muted: boolean) => void;

  joinVoice: () => Promise<void>;
  leaveVoice: () => void;
  setMicOn: (on: boolean) => void;
  setSpeakerOn: (on: boolean) => void;
  setPeerVolume: (userId: string, volume: number) => void;
}

let socket: NmuSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let toastSeq = 0;
let eventSeq = 0;
/** The voice mesh, created on demand. Outside the store: it holds live
 *  RTCPeerConnections and MediaStreams, which are not React state. */
let voice: VoiceEngine | null = null;

/** Promise wrapper over an acked emit, rejecting with the server's error. */
function emit<T>(event: keyof ClientToServerEvents, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) return reject(new Error('not connected'));
    const done = (ack: Ack<T>) => (ack.ok ? resolve(ack.data) : reject(new Error(ack.error.message)));
    if (payload === undefined) (socket.emit as (e: string, cb: unknown) => void)(event, done);
    else (socket.emit as (e: string, p: unknown, cb: unknown) => void)(event, payload, done);
  });
}

export const useStore = create<State & Actions>((set, get) => ({
  profile: null,
  connection: 'idle',
  rtt: null,
  room: null,
  snapshot: null,
  events: [],
  chat: [],
  reactions: [],
  toasts: [],
  gameOver: null,
  muted: loadMutePreference(),
  voiceOn: false,
  micOn: false,
  speakerOn: true,
  levels: {},
  voicePeers: [],
  hasTurn: true,

  setProfile: (profile) => set({ profile }),

  toast: (kind, text) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), 4000);
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  connect: (token) => {
    if (socket) socket.disconnect();
    set({ connection: 'connecting' });

    socket = io({
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 20,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });

    socket.on('connect', () => {
      set({ connection: 'connected' });
      // The server pushes room and game state on connect for anyone with a
      // live seat, so a refresh restores the table without asking for it.
    });

    socket.io.on('reconnect_attempt', () => set({ connection: 'reconnecting' }));
    socket.on('disconnect', (reason) => {
      set({ connection: reason === 'io client disconnect' ? 'idle' : 'reconnecting', rtt: null });
    });
    socket.io.on('reconnect_failed', () => {
      set({ connection: 'failed' });
      get().toast('error', 'Lost connection. Reload to rejoin.');
    });

    socket.on('connect_error', (err) => {
      // An auth failure is terminal: the token is stale, so stop retrying.
      if (/token|unauthorized|account/i.test(err.message)) {
        set({ connection: 'failed', profile: null });
        tokenStore.clear();
      }
    });

    socket.on('room:state', (room) => set({ room }));

    socket.on('game:state', (snapshot) => set({ snapshot }));

    socket.on('game:events', (incoming) =>
      set((s) => ({
        // Capped: the log is only ever read from the tail for effects.
        events: [...s.events, ...incoming.map((e) => ({ id: ++eventSeq, e }))].slice(-60),
      })),
    );

    socket.on('game:over', (payload) => set({ gameOver: payload }));

    socket.on('chat:message', (msg) =>
      set((s) => ({ chat: [...s.chat, msg].slice(-100) })),
    );

    socket.on('chat:reaction', (msg) =>
      set((s) => ({ reactions: [...s.reactions, msg].slice(-20) })),
    );

    // --- voice signalling ---
    // The engine is created lazily on joinVoice; these just forward.
    socket.on('voice:offer', ({ from, data }) => void voice?.onOffer(from, data));
    socket.on('voice:answer', ({ from, data }) => void voice?.onAnswer(from, data));
    socket.on('voice:ice', ({ from, data }) => void voice?.onIce(from, data));
    socket.on('voice:left', ({ userId }) => voice?.removePeer(userId));

    socket.on('error', (err: ErrorPayload) => get().toast('error', err.message));

    // RTT probe. The server echoes its clock; we only use our own send time,
    // so an unsynced device clock cannot skew the measurement.
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (!socket?.connected) return;
      const sent = performance.now();
      (socket.emit as (e: string, cb: () => void) => void)('net:ping', () => {
        set({ rtt: Math.round(performance.now() - sent) });
      });
    }, 3000);
  },

  disconnect: () => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    voice?.stop();
    voice = null;
    socket?.disconnect();
    socket = null;
    set({ connection: 'idle', room: null, snapshot: null, rtt: null, gameOver: null });
  },

  createRoom: async (settings, password) => {
    const { code } = await emit<{ code: string }>('room:create', { settings, password });
    set({ chat: [], gameOver: null });
    return code;
  },

  joinRoom: async (code, password) => {
    const res = await emit<{ code: string }>('room:join', { code, password });
    set({ chat: [], gameOver: null });
    return res.code;
  },

  leaveRoom: async () => {
    await emit('room:leave');
    voice?.stop();
    voice = null;
    set({
      room: null,
      snapshot: null,
      chat: [],
      gameOver: null,
      events: [],
      voiceOn: false,
      micOn: false,
      voicePeers: [],
      levels: {},
    });
  },

  updateSettings: (settings) => emit('room:settings', settings),
  startGame: async () => {
    set({ gameOver: null });
    await emit('room:start');
  },
  kick: (userId) => emit('room:kick', { userId }),
  transferHost: (userId) => emit('room:transferHost', { userId }),

  play: (cardId, color) => emit('game:play', color ? { cardId, color } : { cardId }),
  draw: () => emit('game:draw'),
  pass: () => emit('game:pass'),
  chooseRouletteColor: (color) => emit('game:rouletteColor', { color }),
  chooseSwapTarget: (targetId) => emit('game:swapTarget', { targetId }),
  callUno: () => emit('game:callUno'),

  sendChat: (text) => emit('chat:send', { text }),
  react: (reaction) => emit('chat:react', { reaction }),

  joinVoice: async () => {
    const { profile, toast } = get();
    if (!profile || voice) return;

    let iceServers: RTCIceServer[] = [];
    let hasTurn = true;
    try {
      const res = await api.iceServers();
      iceServers = res.iceServers as RTCIceServer[];
      hasTurn = res.hasTurn;
    } catch {
      // Without any ICE config only same-network peers will connect, which is
      // worth saying out loud rather than letting it fail as silence.
      toast('error', 'Could not fetch voice servers; connections may fail.');
    }

    const engine = new VoiceEngine(
      {
        sendOffer: (to, data) => socket?.emit('voice:offer', { to, data }),
        sendAnswer: (to, data) => socket?.emit('voice:answer', { to, data }),
        sendIce: (to, data) => socket?.emit('voice:ice', { to, data }),
        reportMic: (micOn) => socket?.emit('voice:state', { micOn }),
      },
      {
        onPeersChanged: (voicePeers) => set({ voicePeers }),
        onLevels: (levels) => set({ levels }),
        onError: (message) => toast('error', message),
      },
    );

    try {
      await engine.start(profile.id, iceServers);
    } catch {
      return; // start() already surfaced the reason
    }

    voice = engine;
    // Respect the saved preference: someone who always joins muted should not
    // have to remember to hit mute before every game.
    const micOn = profile.micDefaultOn;
    if (!micOn) engine.setMicEnabled(false);
    set({ voiceOn: true, micOn, speakerOn: true, hasTurn });

    if (!hasTurn) {
      toast('info', 'No relay configured — voice may not connect on some networks.');
    }

    try {
      const { userIds } = await emit<{ userIds: string[] }>('voice:join');
      await engine.connectTo(userIds);
    } catch (err) {
      toast('error', (err as Error).message);
    }
  },

  leaveVoice: () => {
    voice?.stop();
    voice = null;
    socket?.emit('voice:leave', () => undefined);
    set({ voiceOn: false, micOn: false, voicePeers: [], levels: {} });
  },

  setMicOn: (on) => {
    voice?.setMicEnabled(on);
    set({ micOn: on });
  },

  setSpeakerOn: (on) => {
    voice?.setSpeakerEnabled(on);
    set({ speakerOn: on });
  },

  setPeerVolume: (userId, volume) => {
    voice?.setPeerVolume(userId, volume);
  },

  setMuted: (muted) => {
    sound.setMuted(muted);
    saveMutePreference(muted);
    set({ muted });
  },

  signOut: async () => {
    get().disconnect();
    await api.signOut().catch(() => undefined);
    tokenStore.clear();
    set({ profile: null, chat: [], reactions: [] });
  },
}));

// --- network quality -------------------------------------------------------

/** RTT above this for a sustained period is worth telling the player about. */
export const SLOW_RTT_MS = 400;
/** Consecutive samples needed before warning, and before saying it recovered. */
const SLOW_SAMPLES = 3;

/**
 * Warn when the connection is genuinely bad, not when one round-trip was slow.
 *
 * The probe runs every 3s, so three consecutive bad samples is ~9s of real
 * degradation. Without that hysteresis a single hiccup on mobile data would
 * throw a scary toast on an otherwise fine link, and people would learn to
 * ignore it -- which is worse than not warning at all.
 */
export function useNetworkAlerts(): void {
  const rtt = useStore((s) => s.rtt);
  const toast = useStore((s) => s.toast);
  const inRoom = useStore((s) => s.room !== null);

  const badRun = useRef(0);
  const goodRun = useRef(0);
  const warned = useRef(false);

  useEffect(() => {
    if (!inRoom || rtt === null) return;

    if (rtt > SLOW_RTT_MS) {
      goodRun.current = 0;
      badRun.current += 1;
      if (badRun.current >= SLOW_SAMPLES && !warned.current) {
        warned.current = true;
        toast('error', 'Slow connection — you may lag behind the table.');
      }
    } else {
      badRun.current = 0;
      goodRun.current += 1;
      if (goodRun.current >= SLOW_SAMPLES && warned.current) {
        warned.current = false;
        toast('info', 'Connection is back to normal.');
      }
    }
  }, [rtt, inRoom, toast]);

  // Leaving the room resets the warning, so rejoining starts clean.
  useEffect(() => {
    if (!inRoom) {
      badRun.current = 0;
      goodRun.current = 0;
      warned.current = false;
    }
  }, [inRoom]);
}

// --- selectors -------------------------------------------------------------

export const selectMe = (s: State) => s.snapshot?.view.you ?? null;

export const selectIsMyTurn = (s: State) =>
  !!s.profile && s.snapshot?.view.turnPlayerId === s.profile.id;

export const selectIsHost = (s: State) => !!s.profile && s.room?.hostId === s.profile.id;

/** Display name for a user id, falling back to a short id if they have left. */
export function nameOf(room: RoomView | null, userId: string): string {
  return room?.members.find((m) => m.id === userId)?.displayName ?? userId.slice(0, 6);
}
