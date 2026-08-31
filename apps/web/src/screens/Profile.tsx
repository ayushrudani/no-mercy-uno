/**
 * Profile: settings on the left, record on the right.
 *
 * Settings save on change rather than behind a Save button -- there are only a
 * handful of them, each is independently meaningful, and nobody wants to
 * remember to press Save before a game starts.
 */

import { useEffect, useState } from 'react';
import { CardBack, CARD_BACK_IDS, isCardBackId } from '../components/Card.js';
import { api, type MatchSummary, type Profile as ProfileT } from '../lib/api.js';
import { summarise, type Stats } from '../lib/stats.js';
import { sound } from '../lib/sound.js';
import { useStore } from '../lib/store.js';

const TURN_OPTIONS = [15, 30, 60, 0] as const;

export function ProfileScreen({
  profile,
  onClose,
}: {
  profile: ProfileT;
  onClose: () => void;
}) {
  const setProfile = useStore((s) => s.setProfile);
  const toast = useStore((s) => s.toast);

  const [name, setName] = useState(profile.displayName);
  const [matches, setMatches] = useState<MatchSummary[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .matches()
      .then(({ matches }) => {
        setMatches(matches);
        setStats(summarise(matches, profile.id));
      })
      .catch(() => setMatches([]));
  }, [profile.id]);

  /** Persist a single field and fold the server's answer back into state. */
  const save = async (patch: Parameters<typeof api.updateProfile>[0]) => {
    setSaving(true);
    try {
      const { user } = await api.updateProfile(patch);
      setProfile(user);
      if (patch.sfxVolume !== undefined) sound.setVolume(patch.sfxVolume);
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const commitName = () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === profile.displayName) {
      setName(profile.displayName);
      return;
    }
    void save({ displayName: trimmed });
  };

  return (
    <div className="h-screen-safe overflow-y-auto bg-ink px-5 py-6">
      <div className="mx-auto max-w-3xl">
        <header className="flex items-center justify-between">
          <h1 className="text-lg font-bold">Profile</h1>
          <button type="button" onClick={onClose} className="text-xs text-white/40 underline decoration-white/20 transition hover:text-white/70">
            back to lobby
          </button>
        </header>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          {/* --- settings --- */}
          <section className="panel panel-raised rounded-2xl p-4">
            <div className="flex items-center gap-3">
              <div className="grid h-12 w-12 place-items-center rounded-full bg-white/10 text-sm font-bold ring-1 ring-white/10">
                {profile.avatarUrl ? (
                  <img src={profile.avatarUrl} alt="" className="h-full w-full rounded-full object-cover" />
                ) : (
                  profile.displayName.slice(0, 2).toUpperCase()
                )}
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{profile.displayName}</div>
                <div className="truncate text-[11px] text-white/35">{profile.email}</div>
              </div>
            </div>

            <label className="mt-4 block text-[11px] font-medium text-white/45">Display name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              maxLength={24}
              className="mt-1 w-full field px-3 py-2.5 text-sm"
            />

            <label className="mt-4 block text-[11px] font-medium text-white/45">Card back</label>
            <div className="mt-2 flex gap-2">
              {CARD_BACK_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => void save({ cardBack: id })}
                  aria-label={id}
                  className={`rounded-lg p-0.5 transition-transform hover:scale-105 ${
                    profile.cardBack === id ? 'ring-2 ring-amber-300' : 'ring-1 ring-white/10'
                  }`}
                >
                  <CardBack size="sm" variant={id} />
                </button>
              ))}
            </div>

            <label className="mt-4 block text-[11px] font-medium text-white/45">
              Sound effects: {profile.sfxVolume}%
            </label>
            <input
              type="range"
              min={0}
              max={100}
              value={profile.sfxVolume}
              onChange={(e) => setProfile({ ...profile, sfxVolume: Number(e.target.value) })}
              // Commit on release: a range fires on every pixel, and one PATCH
              // per pixel would hammer the server for no benefit.
              onPointerUp={(e) => void save({ sfxVolume: Number(e.currentTarget.value) })}
              onKeyUp={(e) => void save({ sfxVolume: Number(e.currentTarget.value) })}
              className="mt-1 w-full accent-amber-400"
            />

            <label className="mt-3 flex items-center justify-between text-[11px] font-medium text-white/45">
              <span>Join voice with mic on</span>
              <input
                type="checkbox"
                checked={profile.micDefaultOn}
                onChange={(e) => void save({ micDefaultOn: e.target.checked })}
                className="h-4 w-4 accent-amber-400"
              />
            </label>

            <label className="mt-4 block text-[11px] font-medium text-white/45">
              Preferred turn timer
            </label>
            <div className="mt-1 flex gap-1.5">
              {TURN_OPTIONS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => void save({ preferredTurnSeconds: t })}
                  className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-semibold ${
                    profile.preferredTurnSeconds === t
                      ? 'bg-amber-400 text-slate-900'
                      : 'bg-slate-800 text-slate-300'
                  }`}
                >
                  {t === 0 ? 'Off' : `${t}s`}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-white/30">
              Used as the default when you create a room.
            </p>

            {saving && <p className="mt-3 text-[10px] text-white/35">saving…</p>}
          </section>

          {/* --- record --- */}
          <section className="panel panel-raised rounded-2xl p-4">
            <h2 className="text-sm font-bold">Record</h2>

            {stats && stats.played > 0 ? (
              <>
                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  <Stat label="played" value={stats.played} />
                  <Stat label="won" value={stats.won} />
                  <Stat label="win rate" value={`${stats.winRate}%`} />
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-center">
                  <Stat label="rounds won" value={stats.roundsWon} />
                  <Stat label="best finish" value={stats.bestPlace ? `#${stats.bestPlace}` : '—'} />
                </div>
              </>
            ) : (
              <p className="mt-3 text-xs text-white/40">
                {matches === null ? 'loading…' : 'No games yet. Go and lose a few.'}
              </p>
            )}

            <h3 className="mt-5 text-[11px] font-bold uppercase tracking-wider text-white/35">
              Recent games
            </h3>

            <ul className="mt-2 space-y-1.5">
              {(matches ?? []).slice(0, 10).map((m) => {
                const me = m.players.find((p) => p.userId === profile.id);
                const won = m.winnerId === profile.id;
                return (
                  <li
                    key={m.id}
                    className="flex items-center gap-2 rounded-xl bg-white/4 px-2.5 py-2 text-[11px] ring-1 ring-white/6"
                  >
                    <span
                      className={`w-8 shrink-0 font-bold ${won ? 'text-emerald-400' : 'text-slate-500'}`}
                    >
                      {won ? 'WON' : me?.finalPlace ? `#${me.finalPlace}` : '—'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-white/60">
                      {m.players.map((p) => p.user.displayName).join(', ')}
                    </span>
                    <span className="shrink-0 text-white/25">
                      {m.rounds}r · {formatWhen(m.startedAt)}
                    </span>
                  </li>
                );
              })}
              {matches !== null && matches.length === 0 && (
                <li className="py-2 text-center text-[11px] text-white/25">nothing yet</li>
              )}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl bg-white/5 py-2.5 ring-1 ring-white/8">
      <div className="text-lg font-black leading-none">{value}</div>
      <div className="mt-0.5 text-[9px] uppercase tracking-wider text-white/35">{label}</div>
    </div>
  );
}

/** Relative for anything recent, an actual date once it stops being "ago". */
function formatWhen(iso: string): string {
  const then = new Date(iso).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

export { isCardBackId };
