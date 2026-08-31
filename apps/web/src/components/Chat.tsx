/**
 * Chat drawer and the reaction bar.
 *
 * The drawer is collapsed by default and overlays the table rather than
 * squeezing it -- the table layout is tight enough in landscape that stealing
 * a column for chat would cost more than the chat is worth mid-hand.
 */

import { AnimatePresence, motion } from 'framer-motion';
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
        className="relative rounded-full bg-white/8 px-2.5 py-1 text-[10px] text-white/60 ring-1 ring-white/10 transition hover:bg-white/12"
      >
        chat
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
        className="rounded-full bg-white/8 px-2.5 py-1 text-[11px] ring-1 ring-white/10 transition hover:bg-white/12"
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

/**
 * Reactions float up over the table and fade. Rendered from the tail of the
 * reaction list, keyed on arrival time so each one animates exactly once.
 */
export function FloatingReactions({
  reactions,
  nameOf,
}: {
  reactions: ReactionMessage[];
  nameOf: (id: string) => string;
}) {
  const recent = reactions.slice(-6);

  return (
    <div className="pointer-events-none absolute bottom-28 left-1/2 z-20 -translate-x-1/2">
      <AnimatePresence>
        {recent.map((r) => (
          <motion.div
            key={`${r.userId}-${r.at}`}
            initial={{ opacity: 0, y: 20, scale: 0.6 }}
            animate={{ opacity: 1, y: -60, scale: 1.3 }}
            exit={{ opacity: 0, y: -100, scale: 0.9 }}
            transition={{ duration: 1.8, ease: 'easeOut' }}
            className="absolute left-1/2 flex -translate-x-1/2 flex-col items-center"
            style={{ marginLeft: (Math.abs(hash(r.userId)) % 120) - 60 }}
          >
            <span className="text-3xl drop-shadow-lg">{r.reaction}</span>
            <span className="text-[9px] text-slate-300">{nameOf(r.userId)}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/** Stable horizontal offset per player, so two reactions do not stack exactly. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}
