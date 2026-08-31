/**
 * Voice controls.
 *
 * Mic and speaker are deliberately separate buttons. Muting yourself and
 * silencing everyone else are completely different intentions, and a single
 * "voice off" toggle forces you to choose between hearing the table and being
 * heard by it.
 */

import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import type { RoomMember } from '@nmu/shared';
import type { PeerState } from '../lib/voice.js';

export function VoiceControls({
  voiceOn,
  micOn,
  speakerOn,
  connecting,
  peers,
  members,
  onJoin,
  onLeave,
  onMic,
  onSpeaker,
  onPeerVolume,
}: {
  voiceOn: boolean;
  micOn: boolean;
  speakerOn: boolean;
  connecting: boolean;
  peers: PeerState[];
  members: RoomMember[];
  onJoin: () => void;
  onLeave: () => void;
  onMic: (on: boolean) => void;
  onSpeaker: (on: boolean) => void;
  onPeerVolume: (userId: string, volume: number) => void;
}) {
  const [mixerOpen, setMixerOpen] = useState(false);

  if (!voiceOn) {
    return (
      <button
        type="button"
        onClick={onJoin}
        disabled={connecting}
        className="rounded-full bg-gradient-to-b from-uno-green to-uno-green-deep px-2.5 py-1 text-[10px] font-bold shadow-lg shadow-emerald-900/40 transition hover:brightness-110 disabled:opacity-45"
      >
        {connecting ? 'connecting…' : '🎙 join voice'}
      </button>
    );
  }

  const connected = peers.filter((p) => p.connection === 'connected').length;
  const failed = peers.some((p) => p.connection === 'failed');

  return (
    <div className="relative flex items-center gap-1">
      <button
        type="button"
        onClick={() => onMic(!micOn)}
        aria-label={micOn ? 'mute microphone' : 'unmute microphone'}
        className={`rounded-full px-2 py-1 text-[11px] ${
          micOn ? 'bg-uno-green/85' : 'bg-red-500/85'
        }`}
      >
        {micOn ? '🎙' : '🔇'}
      </button>

      <button
        type="button"
        onClick={() => onSpeaker(!speakerOn)}
        aria-label={speakerOn ? 'mute everyone' : 'unmute everyone'}
        className={`rounded-full px-2 py-1 text-[11px] ${
          speakerOn ? 'bg-white/8 ring-1 ring-white/10' : 'bg-red-500/85'
        }`}
      >
        {speakerOn ? '🔈' : '🔕'}
      </button>

      <button
        type="button"
        onClick={() => setMixerOpen((o) => !o)}
        className={`rounded-full bg-white/8 px-2 py-1 text-[10px] ring-1 ring-white/10 ${failed ? 'text-red-400' : 'text-white/60'}`}
        aria-label="voice settings"
      >
        {failed ? '⚠' : connected}
      </button>

      <AnimatePresence>
        {mixerOpen && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.96 }}
            className="panel panel-raised absolute right-0 top-8 z-40 w-56 rounded-2xl p-3"
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-bold">On voice</span>
              <button
                type="button"
                onClick={onLeave}
                className="text-[10px] text-red-400 underline"
              >
                leave voice
              </button>
            </div>

            {peers.length === 0 && (
              <p className="py-2 text-center text-[10px] text-white/35">nobody else yet</p>
            )}

            {peers.map((p) => {
              const name = members.find((m) => m.id === p.userId)?.displayName ?? 'player';
              return (
                <div key={p.userId} className="mb-2">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="truncate">{name}</span>
                    <span
                      className={
                        p.connection === 'connected'
                          ? 'text-emerald-400'
                          : p.connection === 'failed'
                            ? 'text-red-400'
                            : 'text-slate-500'
                      }
                    >
                      {p.connection}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(p.volume * 100)}
                    onChange={(e) => onPeerVolume(p.userId, Number(e.target.value) / 100)}
                    className="mt-0.5 w-full accent-amber-400"
                    aria-label={`${name} volume`}
                  />
                </div>
              );
            })}

            {failed && (
              <p className="mt-1 text-[9px] leading-relaxed text-red-300">
                A connection failed. This usually means no TURN relay is reachable.
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * A ring that grows with how loudly someone is talking.
 *
 * Rendered as a box-shadow rather than an extra element so it can sit on an
 * avatar without disturbing the seat layout.
 */
export function speakingRing(level: number, micOn: boolean): string {
  if (!micOn || level <= 0) return '';
  const spread = 2 + Math.round(level * 6);
  const alpha = 0.35 + level * 0.5;
  return `0 0 0 ${spread}px rgba(56,163,74,${alpha.toFixed(2)})`;
}
