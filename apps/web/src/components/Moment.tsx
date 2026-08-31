/**
 * The big-moment banner: Draw 10 landing, Skip Everyone, an elimination.
 *
 * Deliberately non-blocking and short-lived. It sits over the middle of the
 * table with pointer events off, so it can never swallow a tap on a card --
 * a modal here would be actively hostile when the turn clock is running.
 */

import { AnimatePresence, motion } from 'framer-motion';
import type { Moment } from '../lib/effects.js';

const TONE: Record<Moment['tone'], string> = {
  neutral: 'text-white',
  danger: 'text-red-400',
  good: 'text-emerald-300',
};

export function MomentBanner({ moment }: { moment: Moment | null }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center">
      <AnimatePresence mode="wait">
        {moment && (
          <motion.div
            key={moment.id}
            initial={{ scale: 0.5, opacity: 0, rotate: -8 }}
            animate={{ scale: 1, opacity: 1, rotate: -3 }}
            exit={{ scale: 1.35, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 18 }}
            className="select-none text-center"
          >
            <div
              className={`text-6xl font-black italic tracking-tighter drop-shadow-[0_4px_12px_rgba(0,0,0,.8)] ${TONE[moment.tone]}`}
            >
              {moment.text}
            </div>
            {moment.sub && (
              <div className="mt-1 text-xs font-bold uppercase tracking-[0.25em] text-white/80 drop-shadow">
                {moment.sub}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
