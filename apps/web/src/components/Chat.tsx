/**
 * Chat drawer and the reaction bar.
 *
 * The drawer is collapsed by default and overlays the table rather than
 * squeezing it -- the table layout is tight enough in landscape that stealing
 * a column for chat would cost more than the chat is worth mid-hand.
 */

import { AnimatePresence, motion, type Transition } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { REACTIONS, type ChatMessage, type Reaction, type ReactionMessage } from '@nmu/shared';

export function ChatDrawer({
  messages,
  myId,
  unread,
  open,
  onOpenChange,
  onSend,
}: {
  messages: ChatMessage[];
  myId: string;
  unread: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [messages, open]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
  };

  return (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className="relative shrink-0 whitespace-nowrap rounded-full bg-white/8 px-2.5 py-1 text-[10px] text-white/60 ring-1 ring-white/10 transition hover:bg-white/12"
      >
        💬<span className="ml-1 hidden sm:inline">chat</span>
        {unread > 0 && !open && (
          <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-uno-red px-1 text-[9px] font-bold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 420, damping: 38 }}
            className="panel panel-raised absolute right-0 top-0 z-30 flex h-full w-64 flex-col rounded-l-2xl"
          >
            <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
              <span className="text-xs font-bold">Chat</span>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="text-xs text-slate-400"
                aria-label="close chat"
              >
                ✕
              </button>
            </div>

            <div ref={scroller} className="flex-1 space-y-2 overflow-y-auto px-3 py-2">
              {messages.length === 0 && (
                <p className="pt-4 text-center text-[11px] text-slate-600">nothing yet</p>
              )}
              {messages.map((m) => (
                <div key={m.id} className={m.userId === myId ? 'text-right' : ''}>
                  <div className="text-[9px] text-slate-500">{m.displayName}</div>
                  <div
                    className={`inline-block max-w-full break-words rounded-lg px-2 py-1 text-[11px] ${
                      m.userId === myId ? 'bg-uno-blue/85' : 'bg-white/8 ring-1 ring-white/8'
                    }`}
                  >
                    {m.text}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex gap-1.5 border-t border-white/10 p-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && send()}
                maxLength={500}
                placeholder="say something"
                className="field min-w-0 flex-1 px-2.5 py-1.5 text-[11px]"
              />
              <button
                type="button"
                onClick={send}
                disabled={!draft.trim()}
                className="rounded-lg bg-amber-300 px-3 text-[11px] font-black text-slate-900 transition hover:brightness-110 disabled:opacity-35"
              >
                Send
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/** The quick-fire taunt bar. */
export function ReactionBar({ onReact }: { onReact: (r: Reaction) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="shrink-0 rounded-full bg-white/8 px-2.5 py-1 text-[11px] ring-1 ring-white/10 transition hover:bg-white/12"
        aria-label="reactions"
      >
        😂
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.95 }}
            className="panel panel-raised absolute right-0 top-8 z-30 grid w-44 grid-cols-5 gap-1 rounded-2xl p-2"
          >
            {REACTIONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => {
                  onReact(r);
                  setOpen(false);
                }}
                className="rounded-md py-1 text-lg transition-transform hover:scale-125"
              >
                {r}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** How long a reaction stays on screen before it is dropped. */
export const REACTION_LIFETIME_MS = 2200;

/** Unique per reaction: the same player can send the same emoji twice. */
const reactionKey = (r: ReactionMessage) => `${r.userId}-${r.at}-${r.reaction}`;

/**
 * Which reactions are still young enough to show.
 *
 * Pure so the expiry rule can be tested without a DOM -- this is the logic that
 * was missing, and its absence left emoji on screen permanently.
 */
export function liveReactions(
  reactions: readonly ReactionMessage[],
  now: number,
  lifetime = REACTION_LIFETIME_MS,
): ReactionMessage[] {
  return reactions.filter((r) => now - r.at < lifetime).slice(-6);
}

/**
 * Hoisted so their object identity is stable across renders.
 *
 * Inline literals here were a real bug: a new `animate` object on every render
 * makes Framer restart the animation from its first keyframe, so the emoji sat
 * at opacity 0 for ever and never actually appeared.
 */
const FLOAT_INITIAL = { opacity: 0, y: 20, scale: 0.6 } as const;
const FLOAT_ANIMATE = {
  opacity: [0, 1, 1, 0],
  y: [20, -40, -70, -95],
  scale: [0.6, 1.3, 1.2, 0.9],
};
const FLOAT_TRANSITION: Transition = {
  duration: REACTION_LIFETIME_MS / 1000,
  ease: 'easeOut',
  times: [0, 0.18, 0.65, 1],
};

/**
 * Reactions float up over the table and fade out.
 *
 * The list they arrive in is append-only and capped at 20, so nothing ever
 * leaves it. Expiry has to happen here.
 *
 * It is done with one timeout per reaction rather than a ticking clock. The
 * ticking version had two clocks that could disagree: the interval was started
 * and stopped from a live `Date.now()` check while the filter used a state
 * value updated by that same interval. When the interval was cleared first the
 * state froze one tick short of expiry, and the emoji stayed mounted for ever.
 *
 * There is deliberately no AnimatePresence and no `exit`. The keyframes already
 * end at opacity 0, so by the time the timeout removes one there is nothing
 * left to animate away -- and an exit animation would make unmounting depend on
 * requestAnimationFrame, which a browser stops calling in a background tab.
 * Reactions that arrived while the tab was hidden would then never come off the
 * table when the player switched back to it.
 */
export function FloatingReactions({
  reactions,
  nameOf,
}: {
  reactions: ReactionMessage[];
  nameOf: (id: string) => string;
}) {
  const [live, setLive] = useState<ReactionMessage[]>([]);
  const seen = useRef<Set<string>>(new Set());
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    // Anything already older than its lifetime is backlog -- from a rejoin, or
    // messages that arrived while the tab was hidden. Mark it seen and skip it.
    const fresh = reactions.filter((r) => {
      const key = reactionKey(r);
      if (seen.current.has(key)) return false;
      seen.current.add(key);
      return Date.now() - r.at < REACTION_LIFETIME_MS;
    });
    if (fresh.length === 0) return;

    setLive((cur) => [...cur, ...fresh].slice(-6));

    for (const r of fresh) {
      const key = reactionKey(r);
      timers.current.push(
        setTimeout(
          () => setLive((cur) => cur.filter((x) => reactionKey(x) !== key)),
          REACTION_LIFETIME_MS,
        ),
      );
    }
  }, [reactions]);

  useEffect(
    () => () => {
      for (const t of timers.current) clearTimeout(t);
    },
    [],
  );

  return (
    <div className="pointer-events-none absolute bottom-28 left-1/2 z-20 -translate-x-1/2">
      {live.map((r) => (
          <motion.div
            key={reactionKey(r)}
            initial={FLOAT_INITIAL}
            animate={FLOAT_ANIMATE}
            transition={FLOAT_TRANSITION}
            className="absolute left-1/2 flex -translate-x-1/2 flex-col items-center"
            style={{ marginLeft: (Math.abs(hash(r.userId)) % 120) - 60 }}
          >
          <span className="text-3xl drop-shadow-lg">{r.reaction}</span>
          <span className="text-[9px] text-white/60">{nameOf(r.userId)}</span>
        </motion.div>
      ))}
    </div>
  );
}

/** Stable horizontal offset per player, so two reactions do not stack exactly. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}
