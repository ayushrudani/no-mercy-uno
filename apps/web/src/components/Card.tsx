/**
 * Card rendering.
 *
 * Drawn in CSS rather than loaded as images: 168 cards across nine kinds, and
 * what matters at phone size is reading the threat at a glance.
 *
 * The design deliberately drops the retro white oval. At 56px wide the oval ate
 * most of the face and forced the numeral down to a size you had to squint at.
 * Instead: a full-bleed colour gradient, a large numeral in white with a soft
 * shadow, a thin inner hairline for depth, and a diagonal sheen. The colour is
 * the whole card, so a fanned hand reads as bands of colour and the value sits
 * on top of it.
 *
 * `layoutId` is the card's stable server id, so Framer Motion animates the same
 * card continuously from your hand to the discard pile with no extra state.
 */

import { motion } from 'framer-motion';
import type { Card, Color } from '@nmu/shared';

/** Face colour and its darker partner, used for the gradient and the rim. */
const PALETTE: Record<Color, { base: string; deep: string }> = {
  red: { base: '#ef4444', deep: '#a41414' },
  yellow: { base: '#f5b301', deep: '#a15c05' },
  green: { base: '#22c55e', deep: '#11683a' },
  blue: { base: '#3b82f6', deep: '#1a3fa8' },
};

export const COLOR_HEX: Record<Color, string> = {
  red: PALETTE.red.base,
  yellow: PALETTE.yellow.base,
  green: PALETTE.green.base,
  blue: PALETTE.blue.base,
};

export type CardSize = 'sm' | 'md' | 'lg';

/**
 * Sizes come from CSS custom properties, not fixed pixels.
 *
 * The table has to fit a phone in landscape (~390px tall) and a desktop window
 * in the same three-band layout. Hardcoding 126px for a pile card meant the
 * bands could not all fit on a handset and the hand was clipped off the bottom
 * of the screen. The tokens and their height breakpoints live in index.css.
 */
const SIZE: Record<CardSize, { w: string; h: string; glyph: string; label: string; index: string }> = {
  sm: {
    w: 'var(--mini-w)',
    h: 'var(--mini-h)',
    glyph: 'var(--mini-glyph)',
    label: 'var(--mini-label)',
    index: 'var(--mini-index)',
  },
  md: {
    w: 'var(--card-w)',
    h: 'var(--card-h)',
    glyph: 'var(--card-glyph)',
    label: 'var(--card-label)',
    index: 'var(--card-index)',
  },
  lg: {
    w: 'var(--pile-w)',
    h: 'var(--pile-h)',
    glyph: 'var(--pile-glyph)',
    label: 'var(--pile-label)',
    index: 'var(--pile-index)',
  },
};

/** Centre glyph, a word beneath it where that helps, and the corner mark. */
function face(card: Card): { glyph: string; label: string | null; index: string; underline?: boolean } {
  switch (card.k) {
    case 'number':
      return {
        glyph: String(card.n),
        label: null,
        index: String(card.n),
        // 6 and 9 are the easiest digits to misread at 11px in a crowded fan;
        // real decks underline them for the same reason.
        underline: card.n === 6 || card.n === 9,
      };
    case 'draw':
      return { glyph: `+${card.amount}`, label: null, index: `+${card.amount}` };
    case 'skip':
      return { glyph: '⃠', label: 'SKIP', index: '⃠' };
    case 'skipEveryone':
      return { glyph: '⃠', label: 'SKIP ALL', index: '⃠' };
    case 'reverse':
      return { glyph: '⇄', label: null, index: '⇄' };
    case 'discardAll':
      return { glyph: '✦', label: 'DISCARD ALL', index: '✦' };
    case 'wildReverseDraw4':
      return { glyph: '+4', label: 'REVERSE', index: '+4' };
    case 'wildDraw':
      return { glyph: `+${card.amount}`, label: 'WILD', index: `+${card.amount}` };
    case 'wildColorRoulette':
      return { glyph: '?', label: 'ROULETTE', index: '?' };
  }
}

export const isWildCard = (c: Card) =>
  c.k === 'wildReverseDraw4' || c.k === 'wildDraw' || c.k === 'wildColorRoulette';

/** Wilds show all four colours, dimmed behind the glyph so it stays readable. */
const WILD_BACKGROUND = `conic-gradient(from 210deg, ${PALETTE.red.base} 0deg 90deg, ${PALETTE.yellow.base} 90deg 180deg, ${PALETTE.green.base} 180deg 270deg, ${PALETTE.blue.base} 270deg 360deg)`;

export interface CardFaceProps {
  card: Card;
  size?: CardSize;
  /** Lifted, fully lit, and ringed. */
  playable?: boolean;
  /** De-emphasised but still legible: you need to read what you cannot play. */
  dimmed?: boolean;
  /** Enables the shared-layout flight animation. Off for static decoration. */
  animate?: boolean;
  /** Fixed tilt in degrees, for cards sitting on the discard pile. */
  tilt?: number;
  onClick?: (() => void) | undefined;
  className?: string | undefined;
}

export function CardFace({
  card,
  size = 'md',
  playable = false,
  dimmed = false,
  animate = false,
  tilt = 0,
  onClick,
  className = '',
}: CardFaceProps) {
  const s = SIZE[size];
  const { glyph, label, index, underline } = face(card);
  const wild = isWildCard(card);
  const skin = wild ? null : PALETTE[card.color];

  return (
    <motion.button
      {...(animate ? { layoutId: card.id } : {})}
      type="button"
      disabled={!onClick}
      onClick={onClick}
      aria-label={describe(card)}
      initial={animate ? { scale: 0.9, opacity: 0 } : false}
      animate={{ scale: 1, opacity: 1, rotate: tilt, y: playable ? -12 : 0 }}
      {...(onClick ? { whileTap: { scale: 0.95 } } : {})}
      transition={{ type: 'spring', stiffness: 520, damping: 34 }}
      style={{
        width: s.w,
        height: s.h,
        background: skin
          ? `linear-gradient(160deg, ${skin.base} 0%, ${skin.base} 46%, ${skin.deep} 100%)`
          : WILD_BACKGROUND,
        boxShadow: playable
          ? `0 0 0 2px #fbbf24, 0 10px 24px -8px rgb(251 191 36 / .55), 0 4px 10px -3px rgb(0 0 0 / .6)`
          : '0 4px 12px -4px rgb(0 0 0 / .65)',
        opacity: dimmed ? 0.55 : 1,
        filter: dimmed ? 'saturate(0.85)' : undefined,
      }}
      className={[
        'relative shrink-0 overflow-hidden rounded-xl outline-none',
        'flex items-center justify-center',
        onClick ? 'cursor-pointer' : 'cursor-default',
        className,
      ].join(' ')}
    >
      {/* Hairline inner edge: reads as thickness without a heavy white border. */}
      <span className="pointer-events-none absolute inset-0 rounded-xl ring-1 ring-inset ring-white/30" />
      <span className="pointer-events-none absolute inset-[3px] rounded-[9px] ring-1 ring-inset ring-black/15" />

      {/* Diagonal sheen across the top-left, so the face is not a flat slab. */}
      <span
        className="pointer-events-none absolute inset-0 rounded-xl"
        style={{
          background:
            'linear-gradient(148deg, rgb(255 255 255 / .28) 0%, rgb(255 255 255 / .06) 34%, rgb(255 255 255 / 0) 55%)',
        }}
      />

      {/* Wilds need their glyph legible over four bright quadrants. */}
      {wild && (
        <span
          className="pointer-events-none absolute inset-0 rounded-xl"
          style={{ background: 'radial-gradient(circle at 50% 46%, rgb(0 0 0 / .62) 0%, rgb(0 0 0 / .18) 62%, rgb(0 0 0 / 0) 78%)' }}
        />
      )}

      <span className="relative flex flex-col items-center leading-none">
        <span
          className={`font-black tracking-tight text-white ${underline ? 'underline decoration-[0.1em] underline-offset-[0.14em]' : ''}`}
          style={{
            fontSize: s.glyph,
            textShadow: '0 2px 6px rgb(0 0 0 / .5), 0 1px 0 rgb(0 0 0 / .25)',
          }}
        >
          {glyph}
        </span>
        {label && (
          <span
            className="mt-1 font-bold uppercase tracking-[0.14em] text-white/85"
            style={{ fontSize: s.label }}
          >
            {label}
          </span>
        )}
      </span>

      {/* Corner index -- readable when the card is mostly covered by the next. */}
      <span
        className={`pointer-events-none absolute left-1.5 top-1 font-black text-white/90 ${
          underline ? 'underline decoration-[0.12em] underline-offset-[0.08em]' : ''
        }`}
        style={{ fontSize: s.index, textShadow: '0 1px 3px rgb(0 0 0 / .55)' }}
      >
        {index}
      </span>
    </motion.button>
  );
}

/**
 * Card-back skins. Purely cosmetic and purely local: you see your own choice,
 * it never leaves your browser, and two players can pick different ones without
 * disagreeing about anything.
 */
export const CARD_BACKS = {
  classic: { from: '#1b1f2e', to: '#0a0c14', mark: '#ef4444', ink: '#ffffff' },
  midnight: { from: '#152244', to: '#070c1c', mark: '#3b82f6', ink: '#dbeafe' },
  bone: { from: '#e9e5d8', to: '#c8c2ae', mark: '#1f2937', ink: '#1f2937' },
  inferno: { from: '#3a1206', to: '#160603', mark: '#f97316', ink: '#ffedd5' },
} as const;

export type CardBackId = keyof typeof CARD_BACKS;
export const CARD_BACK_IDS = Object.keys(CARD_BACKS) as CardBackId[];

export function isCardBackId(value: string): value is CardBackId {
  return value in CARD_BACKS;
}

/** Face-down card, for the draw pile and opponents' hands. */
export function CardBack({
  size = 'md',
  variant = 'classic',
  className = '',
}: {
  size?: CardSize;
  variant?: CardBackId;
  className?: string;
}) {
  const s = SIZE[size];
  const skin = CARD_BACKS[variant] ?? CARD_BACKS.classic;
  return (
    <div
      style={{
        width: s.w,
        height: s.h,
        background: `linear-gradient(160deg, ${skin.from} 0%, ${skin.to} 100%)`,
        boxShadow: '0 4px 12px -4px rgb(0 0 0 / .65)',
      }}
      className={`relative shrink-0 overflow-hidden rounded-xl ${className}`}
    >
      <span className="pointer-events-none absolute inset-0 rounded-xl ring-1 ring-inset ring-white/20" />
      {/* An angled band rather than an oval: cleaner, and it scales down better. */}
      <span
        className="pointer-events-none absolute -inset-x-2 top-1/2 h-1/3 -translate-y-1/2 rotate-[-24deg]"
        style={{ background: skin.mark, opacity: 0.9 }}
      />
      <span
        className="absolute inset-0 grid place-items-center text-center font-black italic leading-none"
        style={{
          fontSize: `calc(${s.glyph} * 0.3)`,
          color: skin.ink,
          textShadow: '0 1px 3px rgb(0 0 0 / .5)',
        }}
      >
        NO
        <br />
        MERCY
      </span>
    </div>
  );
}

/** Screen-reader and aria label. */
export function describe(card: Card): string {
  switch (card.k) {
    case 'number':
      return `${card.color} ${card.n}`;
    case 'draw':
      return `${card.color} draw ${card.amount}`;
    case 'skip':
      return `${card.color} skip`;
    case 'skipEveryone':
      return `${card.color} skip everyone`;
    case 'reverse':
      return `${card.color} reverse`;
    case 'discardAll':
      return `${card.color} discard all`;
    case 'wildReverseDraw4':
      return 'wild reverse draw 4';
    case 'wildDraw':
      return `wild draw ${card.amount}`;
    case 'wildColorRoulette':
      return 'wild color roulette';
  }
}
