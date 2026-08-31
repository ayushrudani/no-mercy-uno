/**
 * The small pieces the table is assembled from: opponent seats, the piles,
 * the turn ring, the colour picker, the network pill, the fullscreen button
 * and toasts.
 */

import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import type { Card, Color, OpponentView, RoomMember } from '@nmu/shared';
import { CardBack, CardFace, COLOR_HEX, type CardBackId } from './Card.js';
import { enterFullscreen, exitFullscreen, fullscreenSupported, isFullscreen } from '../lib/fullscreen.js';
import { chunkRows, layoutHand, type HandSort } from '../lib/hand.js';
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

/**
 * The seat avatar is sized by a CSS token that changes with viewport height, so
 * the SVG turn ring has to read the resolved pixel value rather than assume one.
 */
function seatPx(): number {
  if (typeof window === 'undefined') return 44;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--seat');
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 44;
}

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
            'grid place-items-center rounded-full text-[0.7rem] font-bold',
            'bg-white/10 ring-2 transition-shadow duration-100',
            isTurn ? 'ring-amber-300' : 'ring-white/15',
          ].join(' ')}
          style={{
            width: 'var(--seat)',
            height: 'var(--seat)',
            // A live level ring beats a static "mic on" dot: it tells you who
            // is actually talking, which is the thing you want to know.
            boxShadow: speakingRing(level, member?.micOn ?? false),
          }}
        >
          {member?.avatarUrl ? (
            <img src={member.avatarUrl} alt="" className="h-full w-full rounded-full object-cover" />
          ) : (
            name.slice(0, 2).toUpperCase()
          )}
        </div>
        {isTurn && <TurnRing seconds={seconds} total={turnTotal} size={seatPx() + 8} />}
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

      <span className="flex max-w-20 items-center gap-1 text-[10px] font-medium text-white/55">
        <span className="truncate">
          {offline ? '⚠ ' : ''}
          {name}
        </span>
        {/* Their finishing place, once they have gone out. Without it, a
            player who empties their hand just silently stops taking turns. */}
        {player.place !== null && (
          <span className="shrink-0 rounded-full bg-amber-300/20 px-1 font-bold text-amber-300 ring-1 ring-amber-300/30">
            #{player.place}
          </span>
        )}
      </span>

      {/* A fan of backs, capped so a 20-card hand does not overflow the seat. */}
      {!player.eliminated && player.place === null && (
        <div className="flex items-start">
          {Array.from({ length: Math.min(player.cardCount, 6) }).map((_, i) => (
            <div
              key={i}
              className="rounded-[2px] bg-white/40 ring-1 ring-inset ring-white/50"
              style={{
                width: 'calc(var(--seat) * 0.22)',
                height: 'calc(var(--seat) * 0.36)',
                marginLeft: i === 0 ? 0 : 'calc(var(--seat) * -0.11)',
              }}
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
    <div className="flex items-center" style={{ gap: 'var(--gap)' }}>
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
        <div className="relative" style={{ width: 'var(--pile-w)', height: 'var(--pile-h)' }}>
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

/**
 * Colour choice, shown beside the piles rather than as a full-screen modal.
 *
 * A modal blanked the whole table for what is a one-tap decision, hiding your
 * own hand at exactly the moment you are deciding what the colour should be.
 * Sitting it next to the deck keeps the table readable and puts the choice
 * where the eye already is.
 */
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
    <motion.div
      initial={{ opacity: 0, scale: 0.85, x: -12 }}
      animate={{ opacity: 1, scale: 1, x: 0 }}
      exit={{ opacity: 0, scale: 0.85 }}
      transition={{ type: 'spring', stiffness: 460, damping: 26 }}
      className="panel panel-raised shrink-0 rounded-2xl p-2.5 text-center ring-2 ring-amber-300/50"
    >
      <div className="text-[10px] font-bold leading-tight">{title}</div>
      {subtitle && (
        <div className="mt-0.5 max-w-[8.5rem] text-[9px] leading-snug text-white/45">{subtitle}</div>
      )}

      <div className="mt-2 grid grid-cols-2 gap-1.5">
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onPick(c)}
            aria-label={c}
            style={{
              background: COLOR_HEX[c],
              width: 'calc(var(--pile-w) * 0.46)',
              height: 'calc(var(--pile-w) * 0.46)',
            }}
            className="rounded-xl shadow-lg ring-2 ring-white/25 transition hover:scale-110 hover:ring-white/70 active:scale-95"
          />
        ))}
      </div>

      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="mt-1.5 text-[9px] text-white/40 underline underline-offset-2"
        >
          cancel
        </button>
      )}
    </motion.div>
  );
}

/**
 * Who to swap hands with after playing a 7.
 *
 * Card counts are shown because that is the entire decision -- you are picking
 * a hand, and its size is the only thing you know about it.
 */
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

/** Who to swap hands with after playing a 7, shown beside the piles. */
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
    <motion.div
      initial={{ opacity: 0, scale: 0.85, x: -12 }}
      animate={{ opacity: 1, scale: 1, x: 0 }}
      exit={{ opacity: 0, scale: 0.85 }}
      transition={{ type: 'spring', stiffness: 460, damping: 26 }}
      className="panel panel-raised shrink-0 rounded-2xl p-2.5 text-center ring-2 ring-amber-300/50"
    >
      <div className="text-[10px] font-bold leading-tight">Take a hand</div>
      <div className="mt-0.5 max-w-[9rem] text-[9px] leading-snug text-white/45">
        You played a 7. Card counts shown.
      </div>

      <div className="mt-2 flex max-w-[10rem] flex-wrap justify-center gap-1.5">
        {candidates.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onPick(id)}
            className="min-w-12 rounded-xl bg-white/6 px-2 py-1.5 ring-1 ring-white/12 transition hover:bg-white/12 hover:ring-amber-300 active:scale-95"
          >
            <div className="text-base font-black leading-none">{countOf(id)}</div>
            <div className="mt-0.5 max-w-14 truncate text-[9px] text-white/55">{nameOf(id)}</div>
          </button>
        ))}
      </div>
    </motion.div>
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
 * There is deliberately no rotate-to-landscape gate any more.
 *
 * It existed because the table was sized in fixed pixels and genuinely did not
 * fit a narrow screen. Now that every element is sized from height-aware CSS
 * tokens and the seat row wraps, portrait works -- and blocking the app behind
 * "turn your phone" was a worse experience than a slightly tighter layout.
 */

// ---------------------------------------------------------------------------
// Fullscreen
// ---------------------------------------------------------------------------

/**
 * Fullscreen state, kept in sync with the browser rather than with our clicks.
 *
 * The user can leave fullscreen without touching our button -- Escape on a
 * desktop, the back gesture or a swipe-down on a phone -- so `fullscreenchange`
 * is the source of truth. Tracking our own clicks instead would leave the
 * button showing "exit" on a page that is no longer fullscreen.
 */
export function useFullscreen(): {
  supported: boolean;
  active: boolean;
  toggle: () => void;
} {
  const [supported] = useState(fullscreenSupported);
  const [active, setActive] = useState(isFullscreen);

  useEffect(() => {
    const sync = () => setActive(isFullscreen());
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  const toggle = () => {
    // Errors here are the browser refusing the request (no user gesture, or a
    // permissions policy). Nothing to recover, and an error toast mid-game
    // would be worse than the button appearing not to work.
    void (active ? exitFullscreen() : enterFullscreen()).catch(() => {});
  };

  return { supported, active, toggle };
}

/** Renders nothing where fullscreen is unavailable, rather than a dead button. */
export function FullscreenButton() {
  const { supported, active, toggle } = useFullscreen();
  if (!supported) return null;

  return (
    <button
      type="button"
      onClick={toggle}
      className="shrink-0 rounded-full bg-white/8 px-2.5 py-1 text-[11px] ring-1 ring-white/10 transition hover:bg-white/12"
      aria-label={active ? 'exit fullscreen' : 'fullscreen and rotate to landscape'}
      title={active ? 'Exit fullscreen' : 'Fullscreen (locks to landscape on a phone)'}
    >
      {active ? '🡼' : '⛶'}
    </button>
  );
}

// ---------------------------------------------------------------------------
// The hand
// ---------------------------------------------------------------------------

/**
 * Your cards, fanned to fit whatever space there is.
 *
 * This replaced a horizontal scroller. Scrolling was the wrong answer twice
 * over: you cannot plan a turn against cards that are off-screen, and on a
 * touch device dragging the rail competed with tapping a card, so picking the
 * card you wanted from a big hand was genuinely fiddly.
 *
 * Now the cards overlap by exactly as much as they must, which is nothing at
 * all for a normal hand and a tight fan for a punished one. The corner index in
 * the top-left of every card is what makes the covered ones still readable, and
 * it is why cards overlap leftwards rather than rightwards.
 */
export function HandRail({
  cards,
  playableIds,
  isMyTurn,
  onCardClick,
}: {
  cards: Card[];
  playableIds: ReadonlySet<string>;
  isMyTurn: boolean;
  onCardClick: (card: Card) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState({ width: 0, cardWidth: 60 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      // Read the card width from the CSS token rather than hardcoding it: the
      // token changes at the height breakpoints, and a stale value here would
      // compute an overlap for a card size that is no longer on screen.
      const token = parseFloat(getComputedStyle(el).getPropertyValue('--card-w'));
      setMetrics({ width: el.clientWidth, cardWidth: Number.isFinite(token) ? token : 60 });
    };
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // The breakpoints are on viewport HEIGHT, so the card token can change
    // without this element's width changing at all -- which ResizeObserver
    // would not report. Hence the window listener as well.
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const layout = layoutHand({
    count: cards.length,
    width: metrics.width,
    cardWidth: metrics.cardWidth,
    gap: 6,
    // Proportional to the card, so the sliver stays readable at every size.
    minStep: Math.max(12, metrics.cardWidth * 0.3),
    // Two at most. Vertical space is the scarce one on a phone in landscape,
    // and a third row would push the fan off the bottom of the screen.
    maxRows: 2,
  });
  const rows = chunkRows(cards, layout.rows);
  const offset = layout.step - metrics.cardWidth;

  return (
    // The padding is on the outer element on purpose. `clientWidth` counts
    // padding, so measuring a padded element would hand the layout 24px it does
    // not have and the last card would hang over the edge. The measured element
    // has no horizontal padding, so its width is exactly the room the cards get.
    <div className="px-3 pb-2 pt-4">
      <div ref={ref} className="flex flex-col items-stretch gap-1">
        {rows.map((row, rowIndex) => (
          <div key={rowIndex} className="flex justify-center">
            <AnimatePresence mode="popLayout" initial={false}>
              {row.map((card, i) => {
                const playable = isMyTurn && playableIds.has(card.id);
                return (
                  <motion.span
                    key={card.id}
                    layout
                    className="relative block shrink-0"
                    style={{
                      marginLeft: i === 0 ? 0 : offset,
                      // Later cards sit on top, so the fan reads left to right.
                      // A playable card jumps above all of them -- half-covered
                      // is fine to read, but not to aim at.
                      zIndex: playable ? 100 + i : i,
                    }}
                  >
                    <CardFace
                      card={card}
                      size="md"
                      animate
                      playable={playable}
                      dimmed={!playableIds.has(card.id)}
                      onClick={playable ? () => onCardClick(card) : undefined}
                    />
                  </motion.span>
                );
              })}
            </AnimatePresence>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Flips between dealt order and grouped by colour, and says which is on. */
export function HandSortToggle({
  sort,
  onChange,
}: {
  sort: HandSort;
  onChange: (next: HandSort) => void;
}) {
  const next: HandSort = sort === 'color' ? 'dealt' : 'color';
  return (
    <button
      type="button"
      onClick={() => onChange(next)}
      className="shrink-0 rounded-full bg-white/8 px-2 py-0.5 text-[10px] text-white/50 ring-1 ring-white/10 transition hover:bg-white/12 hover:text-white/80"
      aria-label={sort === 'color' ? 'sorted by colour, switch to dealt order' : 'dealt order, switch to sorting by colour'}
      title={sort === 'color' ? 'Grouped by colour' : 'In the order they were dealt'}
    >
      {sort === 'color' ? '🎨 colour' : '⇄ dealt'}
    </button>
  );
}
