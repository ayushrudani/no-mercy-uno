/**
 * Lobby: create a room or join one by code. The two panels are deliberately
 * side by side -- there are only ever two things you want to do here.
 */

import { useState } from 'react';
import { DEFAULT_ROOM_SETTINGS, MAX_PLAYERS, MIN_PLAYERS, type RoomSettings } from '@nmu/shared';
import { useStore } from '../lib/store.js';
import type { Profile } from '../lib/api.js';

const TURN_OPTIONS = [15, 30, 60, 0] as const;

export function Lobby({ profile, onOpenProfile }: { profile: Profile; onOpenProfile: () => void }) {
  const createRoom = useStore((s) => s.createRoom);
  const joinRoom = useStore((s) => s.joinRoom);
  const signOut = useStore((s) => s.signOut);
  const toast = useStore((s) => s.toast);

  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<RoomSettings>({
    ...DEFAULT_ROOM_SETTINGS,
    name: `${profile.displayName}'s table`,
    turnSeconds: (TURN_OPTIONS as readonly number[]).includes(profile.preferredTurnSeconds)
      ? (profile.preferredTurnSeconds as RoomSettings['turnSeconds'])
      : 30,
  });
  const [createPw, setCreatePw] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [joinPw, setJoinPw] = useState('');

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-screen-safe overflow-y-auto bg-ink px-5 py-6">
      <header className="mx-auto flex max-w-3xl items-center justify-between">
        <h1 className="text-xl font-black italic tracking-tight">
          NO <span className="text-uno-red">MERCY</span>
        </h1>
        <div className="flex items-center gap-3 text-xs">
          <button
            type="button"
            onClick={onOpenProfile}
            className="panel flex items-center gap-2 rounded-full px-2 py-1 transition hover:bg-white/10"
          >
            <span className="grid h-6 w-6 place-items-center rounded-full bg-white/10 text-[9px] font-bold">
              {profile.avatarUrl ? (
                <img src={profile.avatarUrl} alt="" className="h-full w-full rounded-full object-cover" />
              ) : (
                profile.displayName.slice(0, 2).toUpperCase()
              )}
            </span>
            <span className="text-white/70">{profile.displayName}</span>
          </button>
          <button type="button" onClick={() => void signOut()} className="text-white/35 underline decoration-white/20 transition hover:text-white/60">
            sign out
          </button>
        </div>
      </header>

      <div className="mx-auto mt-6 grid max-w-3xl gap-4 sm:grid-cols-2">
        {/* --- create --- */}
        <section className="panel panel-raised rounded-2xl p-4">
          <h2 className="text-sm font-bold">Start a table</h2>

          <label className="mt-3 block text-[11px] font-medium text-white/45">Room name</label>
          <input
            value={settings.name}
            onChange={(e) => setSettings({ ...settings, name: e.target.value })}
            maxLength={40}
            className="mt-1 w-full field px-3 py-2.5 text-sm"
          />

          <label className="mt-3 block text-[11px] font-medium text-white/45">Password</label>
          <input
            value={createPw}
            onChange={(e) => setCreatePw(e.target.value)}
            type="password"
            maxLength={64}
            placeholder="share this with the group"
            className="mt-1 w-full field px-3 py-2.5 text-sm"
          />

          <label className="mt-3 block text-[11px] font-medium text-white/45">
            Max players: {settings.maxPlayers}
          </label>
          <input
            type="range"
            min={MIN_PLAYERS}
            max={MAX_PLAYERS}
            value={settings.maxPlayers}
            onChange={(e) => setSettings({ ...settings, maxPlayers: Number(e.target.value) })}
            className="mt-1 w-full accent-amber-400"
          />

          <label className="mt-3 block text-[11px] font-medium text-white/45">Turn timer</label>
          <div className="mt-1 flex gap-1.5">
            {TURN_OPTIONS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setSettings({ ...settings, turnSeconds: t })}
                className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-semibold ${
                  settings.turnSeconds === t ? 'bg-amber-300 text-slate-900 shadow-lg shadow-amber-300/20' : 'bg-white/6 text-white/60 ring-1 ring-white/10 hover:bg-white/10'
                }`}
              >
                {t === 0 ? 'Off' : `${t}s`}
              </button>
            ))}
          </div>

          <label className="mt-4 block text-[11px] font-medium text-white/45">How the game ends</label>
          <div className="mt-1 flex gap-1.5">
            <button
              type="button"
              onClick={() =>
                setSettings({ ...settings, rules: { ...settings.rules, eliminationAt: 0, roundsToWin: 3 } })
              }
              className={`flex-1 rounded-lg px-2 py-2 text-xs font-semibold ${
                (settings.rules.eliminationAt ?? 0) === 0
                  ? 'bg-amber-300 text-slate-900 shadow-lg shadow-amber-300/20'
                  : 'bg-white/6 text-white/60 ring-1 ring-white/10 hover:bg-white/10'
              }`}
            >
              First to {settings.rules.roundsToWin ?? 3}
            </button>
            <button
              type="button"
              onClick={() =>
                setSettings({ ...settings, rules: { ...settings.rules, eliminationAt: 25, roundsToWin: 0 } })
              }
              className={`flex-1 rounded-lg px-2 py-2 text-xs font-semibold ${
                (settings.rules.eliminationAt ?? 0) > 0
                  ? 'bg-amber-300 text-slate-900 shadow-lg shadow-amber-300/20'
                  : 'bg-white/6 text-white/60 ring-1 ring-white/10 hover:bg-white/10'
              }`}
            >
              Knock out at 25
            </button>
          </div>
          <p className="mt-1 text-[10px] leading-snug text-white/40">
            {(settings.rules.eliminationAt ?? 0) === 0
              ? 'Nobody is ever knocked out. First to win 3 rounds takes the game.'
              : 'Official No Mercy: reach 25 cards and you are out for good. Last player standing wins.'}
          </p>

          <label className="mt-4 flex cursor-pointer items-start justify-between gap-3 rounded-xl bg-white/4 px-3 py-2.5 ring-1 ring-white/8">
            <span>
              <span className="block text-xs font-semibold">7-0 rule</span>
              <span className="mt-0.5 block text-[10px] leading-snug text-white/40">
                Play a 7 to swap hands with anyone. Play a 0 and every hand moves round.
              </span>
            </span>
            <input
              type="checkbox"
              checked={settings.rules.sevenZero ?? false}
              onChange={(e) =>
                setSettings({ ...settings, rules: { ...settings.rules, sevenZero: e.target.checked } })
              }
              className="mt-0.5 h-4 w-4 shrink-0 accent-amber-300"
            />
          </label>

          <label className="mt-2 flex cursor-pointer items-start justify-between gap-3 rounded-xl bg-white/4 px-3 py-2.5 ring-1 ring-white/8">
            <span>
              <span className="block text-xs font-semibold">Call UNO</span>
              <span className="mt-0.5 block text-[10px] leading-snug text-white/40">
                A button appears at two cards. Play down to one without pressing it and you draw{' '}
                {settings.rules.unoPenalty ?? 2}.
              </span>
            </span>
            <input
              type="checkbox"
              checked={settings.rules.unoCall ?? false}
              onChange={(e) =>
                setSettings({ ...settings, rules: { ...settings.rules, unoCall: e.target.checked } })
              }
              className="mt-0.5 h-4 w-4 shrink-0 accent-amber-300"
            />
          </label>

          <button
            type="button"
            disabled={busy || !createPw || !settings.name.trim()}
            onClick={() => void run(() => createRoom(settings, createPw))}
            className="mt-5 w-full rounded-xl bg-gradient-to-b from-uno-red to-uno-red-deep px-4 py-3 text-sm font-black uppercase tracking-wide shadow-lg shadow-red-900/40 transition hover:brightness-110 active:scale-[.98] disabled:opacity-35 disabled:shadow-none"
          >
            Create room
          </button>
        </section>

        {/* --- join --- */}
        <section className="panel panel-raised rounded-2xl p-4">
          <h2 className="text-sm font-bold">Join a table</h2>

          <label className="mt-3 block text-[11px] font-medium text-white/45">Room code</label>
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, ''))}
            maxLength={6}
            placeholder="ABC234"
            className="mt-1 w-full field px-3 py-2.5 text-center text-2xl font-black tracking-[0.35em]"
          />

          <label className="mt-3 block text-[11px] font-medium text-white/45">Password</label>
          <input
            value={joinPw}
            onChange={(e) => setJoinPw(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && joinCode.length === 6 && void run(() => joinRoom(joinCode, joinPw))}
            type="password"
            maxLength={64}
            className="mt-1 w-full field px-3 py-2.5 text-sm"
          />

          <button
            type="button"
            disabled={busy || joinCode.length !== 6 || !joinPw}
            onClick={() => void run(() => joinRoom(joinCode, joinPw))}
            className="mt-5 w-full rounded-xl bg-gradient-to-b from-uno-blue to-uno-blue-deep px-4 py-3 text-sm font-black uppercase tracking-wide shadow-lg shadow-blue-900/40 transition hover:brightness-110 active:scale-[.98] disabled:opacity-35 disabled:shadow-none"
          >
            Join room
          </button>

          <p className="mt-3 text-[11px] leading-relaxed text-white/30">
            Codes are six characters. O, 0, I and 1 are never used, so there is nothing
            ambiguous to mistype.
          </p>
        </section>
      </div>
    </div>
  );
}
