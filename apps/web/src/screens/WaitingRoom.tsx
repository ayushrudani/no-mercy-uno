/**
 * Waiting room: who is here, the code to share, and the host's start button.
 */

import { useState } from 'react';
import type { RoomView } from '@nmu/shared';
import { speakingRing, VoiceControls } from '../components/Voice.js';
import { selectIsHost, useStore } from '../lib/store.js';
import type { Profile } from '../lib/api.js';

export function WaitingRoom({ room, profile }: { room: RoomView; profile: Profile }) {
  const isHost = useStore(selectIsHost);
  const startGame = useStore((s) => s.startGame);
  const leaveRoom = useStore((s) => s.leaveRoom);
  const kick = useStore((s) => s.kick);
  const transferHost = useStore((s) => s.transferHost);
  const toast = useStore((s) => s.toast);
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

  const [copied, setCopied] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const joinVoice = () => {
    setConnecting(true);
    void joinVoiceAction().finally(() => setConnecting(false));
  };

  const run = (fn: () => Promise<unknown>) => {
    fn().catch((err: Error) => toast('error', err.message));
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(room.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast('info', `Room code: ${room.code}`);
    }
  };

  const canStart = room.members.length >= 2;

  return (
    <div className="h-screen-safe overflow-y-auto bg-ink px-5 py-6">
      <div className="mx-auto max-w-lg">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-lg font-bold">{room.settings.name}</h1>
            <p className="text-xs text-white/45">
              {room.settings.turnSeconds === 0
                ? 'No turn timer'
                : `${room.settings.turnSeconds}s per turn`}{' '}
              · up to {room.settings.maxPlayers} players
            </p>
          </div>
          <button
            type="button"
            onClick={() => run(leaveRoom)}
            className="text-xs text-white/35 underline decoration-white/20 transition hover:text-white/60"
          >
            leave
          </button>
        </div>

        <button
          type="button"
          onClick={() => void copyCode()}
          className="panel panel-raised mt-4 w-full rounded-2xl py-5 transition hover:bg-white/8"
        >
          <div className="text-[10px] uppercase tracking-[0.25em] text-white/30">room code</div>
          <div className="mt-1 text-4xl font-black tracking-[0.3em]">{room.code}</div>
          <div className="mt-1 text-[11px] text-amber-400">
            {copied ? 'copied' : 'tap to copy · share with the group'}
          </div>
        </button>

        {/* Voice is offered here, before the game starts. A browser permission
            prompt appearing mid-hand while the turn clock runs is a good way to
            lose a turn. */}
        <div className="mt-4 flex items-center justify-between panel rounded-xl px-3 py-2.5">
          <div>
            <div className="text-xs font-bold">Voice chat</div>
            <div className="text-[10px] text-white/40">
              {voiceOn
                ? `${voicePeers.filter((p) => p.connection === 'connected').length} connected`
                : 'Set up your mic before the cards are dealt'}
            </div>
          </div>
          <VoiceControls
            voiceOn={voiceOn}
            micOn={micOn}
            speakerOn={speakerOn}
            connecting={connecting}
            peers={voicePeers}
            members={room.members}
            onJoin={joinVoice}
            onLeave={leaveVoice}
            onMic={setMicOn}
            onSpeaker={setSpeakerOn}
            onPeerVolume={setPeerVolume}
          />
        </div>

        <h2 className="mt-6 text-xs font-bold uppercase tracking-wider text-white/35">
          Players ({room.members.length}/{room.settings.maxPlayers})
        </h2>

        <ul className="mt-2 space-y-1.5">
          {room.members.map((m) => (
            <li
              key={m.id}
              className="flex items-center gap-3 panel rounded-xl px-3 py-2.5"
            >
              <div
                className="grid h-9 w-9 place-items-center rounded-full bg-white/10 text-xs font-bold transition-shadow duration-100"
                style={{ boxShadow: speakingRing(levels[m.id] ?? 0, m.micOn) }}
              >
                {m.avatarUrl ? (
                  <img src={m.avatarUrl} alt="" className="h-full w-full rounded-full object-cover" />
                ) : (
                  m.displayName.slice(0, 2).toUpperCase()
                )}
              </div>

              <span className="flex-1 truncate text-sm">
                {m.displayName}
                {m.id === profile.id && <span className="text-slate-500"> (you)</span>}
              </span>

              {m.isHost && (
                <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[9px] font-bold uppercase text-amber-400">
                  host
                </span>
              )}
              {!m.connected && <span className="text-[10px] text-white/40">offline</span>}

              {isHost && m.id !== profile.id && (
                <div className="flex gap-2 text-[10px]">
                  <button
                    type="button"
                    onClick={() => run(() => transferHost(m.id))}
                    className="text-slate-500 underline"
                  >
                    make host
                  </button>
                  <button
                    type="button"
                    onClick={() => run(() => kick(m.id))}
                    className="text-red-400 underline"
                  >
                    kick
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>

        {isHost ? (
          <button
            type="button"
            disabled={!canStart}
            onClick={() => run(startGame)}
            className="mt-6 w-full rounded-2xl bg-gradient-to-b from-uno-green to-uno-green-deep px-4 py-3.5 text-base font-black uppercase tracking-wide shadow-lg shadow-emerald-900/40 transition hover:brightness-110 active:scale-[.99] disabled:opacity-35 disabled:shadow-none"
          >
            {canStart ? 'Deal the cards' : 'Waiting for one more player…'}
          </button>
        ) : (
          <p className="mt-6 text-center text-sm text-white/45">
            Waiting for the host to start…
          </p>
        )}
      </div>
    </div>
  );
}
