/**
 * The small pieces the table is assembled from: opponent seats, the piles,
 * the turn ring, the colour picker, the network pill and toasts.
 */

import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import type { Card, Color, OpponentView, RoomMember } from '@nmu/shared';
import { CardBack, CardFace, COLOR_HEX, type CardBackId } from './Card.js';
import { speakingRing } from './Voice.js';

// ---------------------------------------------------------------------------
// Turn countdown
// ---------------------------------------------------------------------------

/**
 * Countdown derived from the server's absolute deadline.
 *
 * `serverNow` is used to correct for a device clock that disagrees with the
 * server's, so the ring is right even on a phone with a wrong time.
 */
export function useCountdown(turnEndsAt: number | null, serverNow: number | null): number | null {
  const [, tick] = useState(0);

  useEffect(() => {
    if (turnEndsAt === null) return;
    const id = setInterval(() => tick((n) => n + 1), 200);
    return () => clearInterval(id);
  }, [turnEndsAt]);

  if (turnEndsAt === null || serverNow === null) return null;
  const skew = serverNow - Date.now();
  return Math.max(0, Math.round((turnEndsAt - (Date.now() + skew)) / 1000));
}

export function TurnRing({
  seconds,
  total,
  size = 44,
}: {
  seconds: number | null;
  total: number;
  size?: number;
}) {
  if (seconds === null || total <= 0) return null;
  const r = size / 2 - 3;
  const circ = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, seconds / total));
  const urgent = seconds <= 5;

  return (
    <svg width={size} height={size} className="absolute -inset-1 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,.15)" strokeWidth="3" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={urgent ? '#f87171' : '#fbbf24'}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={circ * (1 - frac)}
        className={urgent ? 'animate-pulse-ring' : ''}
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Opponents
// ---------------------------------------------------------------------------

export function Seat({
  player,
  member,
  isTurn,
  seconds,
  turnTotal,
  level = 0,
}: {
  player: OpponentView;
  member: RoomMember | undefined;
  isTurn: boolean;
  seconds: number | null;
  turnTotal: number;
  /** Live voice loudness 0..1, for the speaking ring. */
  level?: number;
}) {
  const name = member?.displayName ?? 'player';
  const offline = member ? !member.connected : true;

  return (
    <div
      className={`flex flex-col items-center gap-1 transition-opacity ${
        player.eliminated ? 'opacity-35' : ''
      }`}
    >
      <div className="relative">
        <div
          className={[
            'grid h-11 w-11 place-items-center rounded-full text-sm font-bold',
            'bg-white/10 ring-2 transition-shadow duration-100',
            isTurn ? 'ring-amber-300' : 'ring-white/15',
          ].join(' ')}
          // A live level ring beats a static "mic on" dot: it tells you who is
          // actually talking, which is the thing you want to know.
          style={{ boxShadow: speakingRing(level, member?.micOn ?? false) }}
        >
          {member?.avatarUrl ? (
            <img src={member.avatarUrl} alt="" className="h-full w-full rounded-full object-cover" />
          ) : (
            name.slice(0, 2).toUpperCase()
          )}
        </div>
        {isTurn && <TurnRing seconds={seconds} total={turnTotal} />}
        {/* Card count is the only thing an opponent's hand exposes. */}
        <span className="absolute -bottom-1 -right-1 min-w-5 rounded-full bg-black/80 px-1 text-center text-[10px] font-bold ring-1 ring-white/25">
          {player.eliminated ? '✕' : player.cardCount}
        </span>
        {player.calledUno && !player.eliminated && (
          <span className="absolute -left-2 -top-1 rounded-full bg-uno-red px-1.5 py-px text-[8px] font-black italic ring-1 ring-white/50">
            UNO
          </span>
        )}
      </div>

      <span className="max-w-16 truncate text-[10px] font-medium text-white/55">
        {offline ? '⚠ ' : ''}
        {name}
      </span>

      {/* A fan of backs, capped so a 20-card hand does not overflow the seat. */}
      {!player.eliminated && (
        <div className="flex h-4 items-start">
          {Array.from({ length: Math.min(player.cardCount, 6) }).map((_, i) => (
            <div
              key={i}
              className="h-4 w-2.5 rounded-[2px] bg-white/40 ring-1 ring-inset ring-white/50"
              style={{ marginLeft: i === 0 ? 0 : -5 }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Piles
// ---------------------------------------------------------------------------

/** A small deterministic tilt per card, so the pile never looks machine-stacked. */
function tiltFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return (Math.abs(h) % 13) - 6;
}

export function Piles({
  top,
  activeColor,
  drawCount,
  pendingDraw,
  pendingTier,
  canDraw,
  onDraw,
  cardBack = 'classic',
}: {
  top: Card;
  activeColor: Color;
  drawCount: number;
  pendingDraw: number;
  pendingTier: number;
  canDraw: boolean;
  onDraw: () => void;
  cardBack?: CardBackId;
}) {
  // Being forced to eat a stack is the one moment the draw pile is not a
  // choice, so it gets the loud red treatment; an ordinary optional draw gets
  // the calmer amber one.
  const forced = canDraw && pendingDraw > 0;

  return (
    <div className="flex items-center gap-7">
      <div className="relative flex flex-col items-center gap-2">
        {/* A visible stack of backs: a single card never looked like a deck. */}
        <button
          type="button"
          onClick={canDraw ? onDraw : undefined}
          disabled={!canDraw}
          className={`group relative block transition-transform duration-150 ${
            canDraw ? 'cursor-pointer hover:-translate-y-1.5 active:scale-95' : 'opacity-75'
          }`}
          aria-label={pendingDraw > 0 ? `take ${pendingDraw} cards` : 'draw a card'}
        >
          <span className="pointer-events-none absolute left-1.5 top-1.5 opacity-45">
            <CardBack size="lg" variant={cardBack} />
          </span>
          <span className="pointer-events-none absolute left-0.5 top-0.5 opacity-75">
            <CardBack size="lg" variant={cardBack} />
          </span>

          <span
            className={`relative block rounded-xl ${
              forced ? 'animate-halo-danger' : canDraw ? 'animate-halo' : ''
            }`}
          >
            <CardBack size="lg" variant={cardBack} />
            {canDraw && (
              <span
                className={`pointer-events-none absolute inset-0 rounded-xl ring-2 ${
                  forced ? 'ring-red-400' : 'ring-amber-300'
                }`}
              />
            )}
          </span>

          {/* The instruction sits on the pile itself. Players look at the cards,
              not at a button somewhere else on screen. */}
          <AnimatePresence>
            {canDraw && (
              <motion.span
                initial={{ opacity: 0, y: -4, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className={`pointer-events-none absolute -bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wider shadow-lg ${
                  forced ? 'bg-red-500 text-white' : 'bg-amber-300 text-slate-900'
                }`}
              >
                {forced ? `take ${pendingDraw}` : 'draw'}
              </motion.span>
            )}
          </AnimatePresence>
        </button>

        <span className="mt-1 text-[10px] font-medium text-white/35">{drawCount} left</span>
      </div>

      <div className="relative flex flex-col items-center gap-2">
        <div className="relative h-[126px] w-[84px]">
          {/* Two static layers give the pile depth. Only the top card is sent to
              the client, so these are decoration -- tilted like a real pile. */}
          <div className="absolute inset-0 rotate-[-9deg] rounded-xl bg-black/45 ring-1 ring-inset ring-white/10" />
          <div className="absolute inset-0 rotate-[6deg] rounded-xl bg-black/55 ring-1 ring-inset ring-white/10" />
          <div className="absolute inset-0 grid place-items-center">
            {/* Keyed by card id so each new top card mounts fresh and animates
                in; `animate` gives it the shared layoutId flight from a hand. */}
            <CardFace key={top.id} card={top} size="lg" animate tilt={tiltFor(top.id)} />
          </div>
        </div>

        {/* A wild leaves the pile showing no single colour, so state it. */}
        <div className="flex items-center gap-1.5">
          <span
            className="h-2.5 w-2.5 rounded-full ring-2 ring-white/25 transition-colors duration-300"
            style={{ background: COLOR_HEX[activeColor] }}
          />
          <span className="text-[10px] font-medium capitalize text-white/40">{activeColor}</span>
        </div>
      </div>

      <AnimatePresence>
        {pendingDraw > 0 && (
          <motion.div
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.6, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 460, damping: 20 }}
            className="rounded-2xl bg-gradient-to-b from-red-500 to-red-700 px-3.5 py-2.5 text-center shadow-[0_10px_28px_-10px_rgb(239_68_68/.8)] ring-1 ring-red-300/60"
          >
            <div className="text-2xl font-black leading-none tracking-tight">+{pendingDraw}</div>
            <div className="mt-0.5 text-[9px] font-bold uppercase tracking-wider text-red-100">
              play +{pendingTier} or higher
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Colour picker
// ---------------------------------------------------------------------------

const COLORS: Color[] = ['red', 'yellow', 'green', 'blue'];

export function ColorPicker({
  title,
  subtitle,
  onPick,
  onCancel,
}: {
  title: string;
  subtitle?: string | undefined;
  onPick: (c: Color) => void;
  onCancel?: (() => void) | undefined;
}) {
  return (
    <div className="absolute inset-0 z-30 grid place-items-center bg-black/70 backdrop-blur-sm">
      <div className="panel panel-raised animate-rise rounded-2xl p-5 text-center">
        <h2 className="text-sm font-bold">{title}</h2>
        {subtitle && <p className="mt-1 text-xs text-white/45">{subtitle}</p>}
        <div className="mt-4 grid grid-cols-2 gap-2.5">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onPick(c)}
              aria-label={c}
              className="h-16 w-16 rounded-2xl shadow-lg ring-2 ring-white/25 transition hover:scale-105 hover:ring-white/60 active:scale-95"
              style={{ background: COLOR_HEX[c] }}
            />
          ))}
        </div>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="mt-4 text-xs text-slate-400 underline underline-offset-2"
          >
            cancel
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The UNO button.
 *
 * Big, loud, and pinned above the hand where the thumb already is. It appears
 * the moment you are down to two cards and is live whoever's turn it is --
 * pressing it is something you do *before* playing your second-to-last card,
 * which is usually while somebody else is still thinking.
 */
export function UnoButton({ onCall }: { onCall: () => void }) {
  return (
    <motion.button
      type="button"
      onClick={onCall}
      initial={{ scale: 0, rotate: -20, opacity: 0 }}
      animate={{ scale: 1, rotate: -6, opacity: 1 }}
      exit={{ scale: 0, opacity: 0 }}
      whileTap={{ scale: 0.9 }}
      transition={{ type: 'spring', stiffness: 420, damping: 14 }}
      className="animate-halo-danger absolute -top-6 left-1/2 z-30 -translate-x-1/2 rounded-full bg-gradient-to-b from-uno-red to-uno-red-deep px-6 py-2.5 text-lg font-black italic tracking-tight text-white ring-2 ring-white/50"
      aria-label="call UNO"
    >
      UNO!
    </motion.button>
  );
}

/**
 * Who to swap hands with after playing a 7.
 *
 * Card counts are shown because that is the entire decision -- you are picking
 * a hand, and its size is the only thing you know about it.
 */
export function SwapPicker({
  candidates,
  nameOf,
  countOf,
  onPick,
}: {
  candidates: string[];
  nameOf: (id: string) => string;
  countOf: (id: string) => number;
  onPick: (id: string) => void;
}) {
  return (
    <div className="absolute inset-0 z-30 grid place-items-center bg-black/75 backdrop-blur-sm">
      <div className="panel panel-raised animate-rise rounded-2xl p-5 text-center">
        <h2 className="text-sm font-bold">Take someone's hand</h2>
        <p className="mt-1 text-xs text-white/45">You played a 7. Swap with anyone.</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {candidates.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => onPick(id)}
              className="min-w-20 rounded-xl bg-white/5 px-3 py-2.5 ring-1 ring-white/10 transition hover:bg-white/10 hover:ring-amber-300 active:scale-95"
            >
              <div className="text-2xl font-black leading-none">{countOf(id)}</div>
              <div className="mt-1 max-w-20 truncate text-[10px] text-white/55">{nameOf(id)}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connection quality
// ---------------------------------------------------------------------------

export function NetworkPill({ rtt, connection }: { rtt: number | null; connection: string }) {
  const bad = connection !== 'connected';
  const tone =
    bad || rtt === null
      ? 'bg-white/25'
      : rtt > 400
        ? 'bg-red-500'
        : rtt > 150
          ? 'bg-amber-400'
          : 'bg-green-500';

  return (
    <div className="flex items-center gap-1.5 rounded-full bg-white/8 px-2 py-1 text-[10px] font-medium ring-1 ring-white/10">
      <span className={`h-2 w-2 rounded-full ${tone} ${bad ? 'animate-pulse-ring' : ''}`} />
      <span className="text-white/55">
        {bad ? connection : rtt === null ? '…' : `${rtt}ms`}
      </span>
    </div>
  );
}

/** Full-screen cover while the socket is down; the table underneath is stale. */
export function ReconnectOverlay({ connection }: { connection: string }) {
  if (connection === 'connected' || connection === 'idle') return null;
  const failed = connection === 'failed';

  return (
    <div className="absolute inset-0 z-50 grid place-items-center bg-black/80 backdrop-blur-sm">
      <div className="text-center">
        <div className="text-lg font-bold">{failed ? 'Disconnected' : 'Reconnecting…'}</div>
        <p className="mt-1 max-w-64 text-xs text-slate-400">
          {failed
            ? 'We could not get back to the table.'
            : 'Holding your seat. Your hand is safe.'}
        </p>
        {failed && (
          <button
            type="button"
            onClick={() => location.reload()}
            className="mt-4 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-900"
          >
            Reload
          </button>
        )}
      </div>
    </div>
  );
}

export function Toasts({
  toasts,
  onDismiss,
}: {
  toasts: { id: number; kind: 'error' | 'info'; text: string }[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="pointer-events-none absolute left-1/2 top-2 z-40 flex -translate-x-1/2 flex-col items-center gap-1.5">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onDismiss(t.id)}
          className={`animate-rise pointer-events-auto rounded-lg px-3 py-1.5 text-xs font-medium shadow-lg ${
            t.kind === 'error' ? 'bg-red-600' : 'bg-slate-700'
          }`}
        >
          {t.text}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Orientation gate
// ---------------------------------------------------------------------------

/**
 * The table needs width. On a narrow portrait screen we ask for a rotation
 * rather than shipping a cramped second layout -- desktop and tablets are left
 * alone, since they are wide enough either way.
 */
export function useNeedsRotation(): boolean {
  const [needs, setNeeds] = useState(false);

  useEffect(() => {
    const check = () => {
      const portrait = window.innerHeight > window.innerWidth;
      const small = Math.min(window.innerWidth, window.innerHeight) < 600;
      setNeeds(portrait && small);
    };
    check();
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
    return () => {
      window.removeEventListener('resize', check);
      window.removeEventListener('orientationchange', check);
    };
  }, []);

  return needs;
}

export function RotateGate() {
  return (
    <div className="grid h-screen-safe place-items-center bg-ink px-8 text-center">
      <div>
        <div className="text-5xl">📱</div>
        <h1 className="mt-4 text-lg font-bold">Turn your phone sideways</h1>
        <p className="mt-2 text-sm text-slate-400">
          No Mercy needs the width to fit everyone at the table.
        </p>
      </div>
    </div>
  );
}
