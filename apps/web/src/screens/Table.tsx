/**
 * The table.
 *
 * Landscape, fixed height, three bands: opponents across the top, the piles in
 * the middle, your hand along the bottom. Nothing here decides legality -- the
 * snapshot's `playableCardIds` drives every highlight, so what looks playable
 * and what the server accepts are the same list by construction.
 *
 * Everything is wrapped in one LayoutGroup so a card keeps its identity as it
 * travels from your hand to the discard pile.
 */

import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import type { Card, Color, GameSnapshot, RoomView } from '@nmu/shared';
import { CardFace, isCardBackId } from '../components/Card.js';
import { ChatDrawer, FloatingReactions, ReactionBar } from '../components/Chat.js';
import { MomentBanner } from '../components/Moment.js';
import { speakingRing, VoiceControls } from '../components/Voice.js';
import {
  ColorWheel,
  DirectionRing,
  FullscreenButton,
  HandRail,
  HandSortToggle,
  NetworkPill,
  NextUp,
  Piles,
  Seat,
  SwapPicker,
  TableCenter,
  UnoButton,
  TurnRing,
  useCountdown,
} from '../components/table-parts.js';
import { useGameEffects, useTurnChime } from '../lib/effects.js';
import { turnActions } from '../lib/turn.js';
import { isHandSort, sortHand, type HandSort } from '../lib/hand.js';
import { nextPlayerId } from '../lib/turnorder.js';
import { sound } from '../lib/sound.js';
import { nameOf, selectIsHost, useStore } from '../lib/store.js';
import { api, type Profile } from '../lib/api.js';

const needsColorChoice = (c: Card) => c.k === 'wildReverseDraw4' || c.k === 'wildDraw';

export function Table({
  room,
  snapshot,
  profile,
}: {
  room: RoomView;
  snapshot: GameSnapshot;
  profile: Profile;
}) {
  const play = useStore((s) => s.play);
  const draw = useStore((s) => s.draw);
  const pass = useStore((s) => s.pass);
  const chooseRouletteColor = useStore((s) => s.chooseRouletteColor);
  const chooseSwapTarget = useStore((s) => s.chooseSwapTarget);
  const callUno = useStore((s) => s.callUno);
  const leaveRoom = useStore((s) => s.leaveRoom);
  const startGame = useStore((s) => s.startGame);
  const sendChat = useStore((s) => s.sendChat);
  const react = useStore((s) => s.react);
  const toast = useStore((s) => s.toast);
  const rtt = useStore((s) => s.rtt);
  const connection = useStore((s) => s.connection);
  const gameOver = useStore((s) => s.gameOver);
  const events = useStore((s) => s.events);
  const chat = useStore((s) => s.chat);
  const reactions = useStore((s) => s.reactions);
  const muted = useStore((s) => s.muted);
  const setMuted = useStore((s) => s.setMuted);
  const voiceOn = useStore((s) => s.voiceOn);
  const micOn = useStore((s) => s.micOn);
  const speakerOn = useStore((s) => s.speakerOn);
  const voicePeers = useStore((s) => s.voicePeers);
  const levels = useStore((s) => s.levels);
  const joinVoiceAction = useStore((s) => s.joinVoice);
  const leaveVoice = useStore((s) => s.leaveVoice);
  const setMicOn = useStore((s) => s.setMicOn);
  const setSpeakerOn = useStore((s) => s.setSpeakerOn);
  const setPeerVolume = useStore((s) => s.setPeerVolume);
  const isHost = useStore(selectIsHost);

  /** A wild waiting on a colour before it can be sent. */
  const [pendingWild, setPendingWild] = useState<Card | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatSeen, setChatSeen] = useState(0);
  const [voiceConnecting, setVoiceConnecting] = useState(false);

  const joinVoice = () => {
    setVoiceConnecting(true);
    void joinVoiceAction().finally(() => setVoiceConnecting(false));
  };

  const view = snapshot.view;
  const setProfile = useStore((st) => st.setProfile);

  const me = view.you;

  /**
   * How the hand is ordered.
   *
   * Held here rather than read straight from the profile so flipping it is
   * instant: the PATCH that persists it is fire-and-forget, and waiting for a
   * round trip to reorder your own cards would feel broken. The profile is the
   * source of truth on load and the toggle writes back to it.
   */
  const [handSort, setHandSortState] = useState<HandSort>(() =>
    isHandSort(profile.handSort) ? profile.handSort : 'dealt',
  );
  const setHandSort = (next: HandSort) => {
    setHandSortState(next);
    setProfile({ ...profile, handSort: next });
    void api.updateProfile({ handSort: next }).catch(() => {
      // Persisting failed; the choice still applies for this session. Nothing
      // worth interrupting a game for.
    });
  };

  const myCards = useMemo(() => sortHand(me?.hand ?? [], handSort), [me?.hand, handSort]);

  /** Who acts after the current player, if the card played does not change it. */
  const nextId = useMemo(() => nextPlayerId(view), [view]);

  // All action gating lives in one tested place: these checks got it wrong once
  // by looking at the table-wide phase without asking whose turn it is.
  const {
    isMyTurn,
    canDraw,
    mustDecideDrawn,
    mustNameRouletteColor,
    mustChooseSwapTarget,
    drawLabel,
    playableIds,
    canCallUno,
  } = turnActions(view, profile.id);

  // The turn clock keeps running while the colour picker is open, so a slow
  // decision can be overtaken by the server auto-playing. Drop the pending
  // wild the moment the turn moves on, rather than leaving a modal open that
  // would fire a move the server is bound to reject.
  useEffect(() => {
    if (!isMyTurn) setPendingWild(null);
  }, [isMyTurn]);

  const seconds = useCountdown(snapshot.turnEndsAt, snapshot.serverNow);
  const turnTotal = room.settings.turnSeconds;

  const nameFor = useMemo(() => (id: string) => nameOf(room, id), [room]);
  const moment = useGameEffects(events, profile.id, nameFor);
  useTurnChime(isMyTurn && !me?.eliminated);

  // Browsers refuse to start audio before a gesture; the first tap anywhere on
  // the table is as good a gesture as any.
  useEffect(() => {
    const unlock = () => sound.unlock();
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  useEffect(() => {
    if (chatOpen) setChatSeen(chat.length);
  }, [chatOpen, chat.length]);

  // Everyone but me, rotated so my left-hand neighbour comes first -- the
  // seating then reads in play order around the top of the screen.
  const opponents = useMemo(() => {
    const seats = view.seats;
    const mine = seats.indexOf(profile.id);
    if (mine < 0) return view.players;
    return [...seats.slice(mine + 1), ...seats.slice(0, mine)]
      .map((id) => view.players.find((p) => p.id === id))
      .filter((p): p is NonNullable<typeof p> => !!p);
  }, [view.seats, view.players, profile.id]);

  const run = (fn: () => Promise<unknown>) => {
    fn().catch((err: Error) => toast('error', err.message));
  };

  const onCardClick = (card: Card) => {
    if (!isMyTurn || !playableIds.has(card.id)) return;
    if (needsColorChoice(card)) {
      setPendingWild(card);
      return;
    }
    run(() => play(card.id));
  };

  const knockoutAt = room.settings.rules.eliminationAt ?? 0;
  // Only a warning when there is something to be knocked out of; 80% of the way
  // to the limit rather than a hardcoded 20.
  const nearElimination = knockoutAt > 0 && (me?.hand.length ?? 0) >= knockoutAt * 0.8;

  // Your finishing place, once you have gone out.
  const myPlace = me?.place ?? null;

  // The seat token changes with viewport height, so the SVG ring around my own
  // avatar has to read the resolved value rather than assume a fixed size.
  const [mySeatRing, setMySeatRing] = useState(38);
  useEffect(() => {
    const measure = () => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--seat');
      const n = parseFloat(raw);
      setMySeatRing((Number.isFinite(n) && n > 0 ? n : 44) * 0.8 + 6);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  return (
    <LayoutGroup>
      <div className="table-felt safe-inset relative flex h-screen-safe flex-col overflow-hidden">
        {/* --- top bar ---------------------------------------------------- */}
        {/* Wraps and shrinks: at 390px wide the labelled controls overflowed and
            pushed "leave" off the edge. Labels collapse to icons below sm. */}
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-2 pt-2 sm:px-3">
          <div className="flex min-w-0 items-center gap-1.5 text-[10px]">
            <span className="shrink-0 rounded-full bg-white/8 px-2 py-1 font-bold tracking-[0.15em] text-white/70 ring-1 ring-white/10">
              {room.code}
            </span>
            <span className="hidden whitespace-nowrap text-white/35 sm:inline">
              {view.players.filter((p) => p.place === null && !p.eliminated).length} still playing
            </span>
            <motion.span
              key={view.direction}
              initial={{ rotate: -180, opacity: 0 }}
              animate={{ rotate: 0, opacity: 1 }}
              className="inline-block text-white/40"
            >
              {view.direction === 1 ? '↻' : '↺'}
            </motion.span>
          </div>

          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <NetworkPill rtt={rtt} connection={connection} />
            <VoiceControls
              voiceOn={voiceOn}
              micOn={micOn}
              speakerOn={speakerOn}
              connecting={voiceConnecting}
              peers={voicePeers}
              members={room.members}
              onJoin={joinVoice}
              onLeave={leaveVoice}
              onMic={setMicOn}
              onSpeaker={setSpeakerOn}
              onPeerVolume={setPeerVolume}
            />
            <ReactionBar onReact={(r) => run(() => react(r))} />
            <ChatDrawer
              messages={chat}
              myId={profile.id}
              unread={Math.max(0, chat.length - chatSeen)}
              open={chatOpen}
              onOpenChange={setChatOpen}
              onSend={(text) => run(() => sendChat(text))}
            />
            <button
              type="button"
              onClick={() => setMuted(!muted)}
              className="shrink-0 rounded-full bg-white/8 px-2.5 py-1 text-[11px] ring-1 ring-white/10 transition hover:bg-white/12"
              aria-label={muted ? 'unmute' : 'mute'}
            >
              {muted ? '🔇' : '🔊'}
            </button>
            <FullscreenButton />
            <button
              type="button"
              onClick={() => run(leaveRoom)}
              className="shrink-0 rounded-full bg-white/8 px-2.5 py-1 text-[10px] text-white/60 ring-1 ring-white/10 transition hover:bg-white/12"
              aria-label="leave room"
            >
              <span className="sm:hidden">✕</span>
              <span className="hidden sm:inline">leave</span>
            </button>
          </div>
        </div>

        {/* --- the table ---------------------------------------------------
            Seats and piles share one bounded surface. Previously each band took
            its own slice of the viewport and the piles band absorbed every
            leftover pixel, which on a desktop left the game as a thin strip of
            content in a very large empty field. */}
        <div className="flex min-h-0 flex-1 items-center justify-center px-2 py-2 sm:px-4">
        {/* Hugs its contents and sits centred, rather than stretching to fill.
            Stretching left the seats pinned to the top edge and the piles
            marooned in the middle of a mostly empty rectangle. */}
        <div className="table-surface relative flex max-h-full w-full max-w-4xl flex-col items-center justify-center gap-3 overflow-hidden px-3 py-5">

        {/* Wraps: eight seats do not fit one row on a phone, and a horizontal
            scroll for opponents would hide half the table. */}
        <div
          className="flex shrink-0 flex-wrap items-start justify-center gap-x-4 gap-y-1 px-3"
        >
          {opponents.map((p) => (
            <Seat
              key={p.id}
              player={p}
              member={room.members.find((m) => m.id === p.id)}
              isTurn={view.turnPlayerId === p.id}
              isNext={nextId === p.id}
              seconds={seconds}
              turnTotal={turnTotal}
              level={levels[p.id] ?? 0}
            />
          ))}
        </div>

        {/* --- piles ------------------------------------------------------- */}
        <div className="relative flex min-h-0 shrink flex-col items-center justify-center gap-1.5">
          <DirectionRing direction={view.direction} />
          <div className="relative z-10 flex items-center justify-center">
          <Piles
            top={view.top}
            activeColor={view.activeColor}
            drawCount={view.drawPileCount}
            pendingDraw={view.pendingDraw}
            pendingTier={view.pendingTier}
            canDraw={canDraw}
            onDraw={() => run(draw)}
            cardBack={isCardBackId(profile.cardBack) ? profile.cardBack : 'classic'}
          />
          </div>
          <div className="relative z-10">
            <NextUp name={nextId ? nameFor(nextId) : null} />
          </div>
        </div>

        </div>
        </div>

        {/* --- my hand -----------------------------------------------------
            shrink-0: flex was allowed to squeeze this, and with the larger
            cards the bottom row ran off the screen edge. The hand is the one
            region that must always be fully reachable. */}
        <div className="relative shrink-0">
          <AnimatePresence>
            {canCallUno && <UnoButton onCall={() => run(callUno)} />}
          </AnimatePresence>
          <div className="mx-auto flex w-full max-w-4xl items-center justify-between px-3 pb-1">
            <div className="flex items-center gap-2">
              <div className="relative">
                <div
                  className={`grid place-items-center rounded-full bg-white/10 text-[10px] font-bold ring-2 transition-shadow duration-100 ${
                    isMyTurn ? 'ring-amber-300' : 'ring-white/15'
                  }`}
                  style={{
                    width: 'calc(var(--seat) * 0.8)',
                    height: 'calc(var(--seat) * 0.8)',
                    boxShadow: speakingRing(levels[profile.id] ?? 0, micOn),
                  }}
                >
                  {profile.displayName.slice(0, 2).toUpperCase()}
                </div>
                {isMyTurn && <TurnRing seconds={seconds} total={turnTotal} size={mySeatRing} />}
              </div>

              <span className="text-[11px] font-semibold text-white/85">
                {me?.eliminated
                  ? 'Knocked out — spectating'
                  : isMyTurn
                    ? mustDecideDrawn
                      ? 'Play it or pass'
                      : 'Your turn'
                    : `${nameFor(view.turnPlayerId ?? '')}'s turn`}
              </span>

              {me && (
                <motion.span
                  animate={nearElimination ? { scale: [1, 1.12, 1] } : { scale: 1 }}
                  {...(nearElimination ? { transition: { repeat: Infinity, duration: 1.4 } } : {})}
                  className={`rounded-full px-2 py-0.5 text-[10px] ${nearElimination ? 'bg-red-500/20 font-bold text-red-300 ring-1 ring-red-400/40' : 'text-white/40'}`}
                >
                  {/* The denominator is the knock-out limit. Showing "/25" with
                      knock-out off implied a cliff that is not there. */}
                  {knockoutAt > 0 ? `${me.hand.length}/${knockoutAt}` : `${me.hand.length} cards`}
                </motion.span>
              )}
              {me && me.hand.length > 1 && (
                <HandSortToggle sort={handSort} onChange={setHandSort} />
              )}
              {myPlace !== null && (
                <span className="rounded-full bg-amber-300/20 px-2 py-0.5 text-[10px] font-bold text-amber-300 ring-1 ring-amber-300/30">
                  finished #{myPlace}
                </span>
              )}
              {me?.calledUno && (
                <span className="rounded-full bg-uno-red px-2 py-0.5 text-[9px] font-black italic ring-1 ring-white/40">
                  UNO
                </span>
              )}
            </div>

            <div className="flex gap-2">
              {mustDecideDrawn && (
                <button
                  type="button"
                  onClick={() => run(pass)}
                  className="rounded-xl bg-white/10 px-3.5 py-1.5 text-[11px] font-semibold ring-1 ring-white/15 transition hover:bg-white/15"
                >
                  Pass
                </button>
              )}
              {canDraw && (
                <motion.button
                  type="button"
                  onClick={() => run(draw)}
                  animate={view.pendingDraw > 0 ? { scale: [1, 1.06, 1] } : { scale: 1 }}
                  {...(view.pendingDraw > 0 ? { transition: { repeat: Infinity, duration: 1.1 } } : {})}
                  className={`rounded-xl px-3.5 py-1.5 text-[11px] font-black uppercase tracking-wide shadow-lg ${
                    view.pendingDraw > 0
                      ? 'bg-red-500 text-white shadow-red-500/30'
                      : 'bg-amber-300 text-slate-900 shadow-amber-300/30'
                  }`}
                >
                  {drawLabel}
                </motion.button>
              )}
            </div>
          </div>

          {me && me.hand.length > 0 && (
            <HandRail
              cards={myCards}
              playableIds={playableIds}
              isMyTurn={isMyTurn}
              onCardClick={onCardClick}
            />
          )}
          {me && me.hand.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-slate-400">no cards</div>
          )}
          {!me && <div className="px-3 py-6 text-center text-xs text-slate-400">spectating</div>}
        </div>

        {/* --- overlays ---------------------------------------------------- */}
        <MomentBanner moment={moment} />
        <FloatingReactions reactions={reactions} nameOf={nameFor} />

        {/* Every mid-turn decision lands in the same place -- the middle of the
            table -- so there is one spot to look when the game asks something. */}
        <AnimatePresence>
          {pendingWild && (
            <TableCenter key="wild">
              <ColorWheel
                title="Choose a colour"
                subtitle="It becomes the active colour."
                onPick={(c: Color) => {
                  const card = pendingWild;
                  setPendingWild(null);
                  run(() => play(card.id, c));
                }}
                onCancel={() => setPendingWild(null)}
              />
            </TableCenter>
          )}

          {mustChooseSwapTarget && (
            <TableCenter key="swap">
              <SwapPicker
                candidates={view.players.filter((p) => !p.eliminated && p.id !== profile.id).map((p) => p.id)}
                nameOf={nameFor}
                countOf={(id) => view.players.find((p) => p.id === id)?.cardCount ?? 0}
                onPick={(id) => run(() => chooseSwapTarget(id))}
              />
            </TableCenter>
          )}

          {mustNameRouletteColor && (
            <TableCenter key="roulette">
              <ColorWheel
                title="Color Roulette"
                subtitle="Name a colour. You draw until it turns up, and lose your turn."
                onPick={(c: Color) => run(() => chooseRouletteColor(c))}
              />
            </TableCenter>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {gameOver && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-40 grid place-items-center bg-black/85 backdrop-blur-sm"
            >
              <motion.div
                initial={{ scale: 0.7, y: 20 }}
                animate={{ scale: 1, y: 0 }}
                transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                className="text-center"
              >
                <div className="text-6xl">🏆</div>
                <h2 className="mt-3 text-3xl font-black italic">
                  {nameFor(gameOver.winnerId)} wins
                </h2>
                <ol className="mt-4 space-y-1 text-sm text-slate-300">
                  {gameOver.standings.map((id, i) => (
                    <li key={id} className={id === profile.id ? 'font-bold text-white' : ''}>
                      <span className="text-slate-500">{i + 1}.</span> {nameFor(id)}
                    </li>
                  ))}
                </ol>
                {isHost && (
                  <button
                    type="button"
                    onClick={() => run(startGame)}
                    className="mt-6 rounded-xl bg-uno-green px-6 py-2.5 text-sm font-bold"
                  >
                    Play again
                  </button>
                )}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </LayoutGroup>
  );
}
