/**
 * Sign-in. Google Identity Services in the real world, plus a development-only
 * shortcut so the app is playable before an OAuth client exists.
 */

import { useEffect, useRef, useState } from 'react';
import { api, tokenStore, type AppConfig, type Profile } from '../lib/api.js';

/** Minimal shape of the GIS global; the full SDK types are not worth pulling in. */
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(opts: { client_id: string; callback: (r: { credential: string }) => void }): void;
          renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
        };
      };
    };
  }
}

export function SignIn({ onSignedIn }: { onSignedIn: (p: Profile) => void }) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [devName, setDevName] = useState('');
  const [busy, setBusy] = useState(false);
  const googleBtn = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.config().then(setConfig).catch(() => setError('Cannot reach the server.'));
  }, []);

  // GIS loads from a <script defer> in index.html, so it may not be ready when
  // this mounts. Poll briefly rather than racing it.
  useEffect(() => {
    if (!config?.googleClientId || !googleBtn.current) return;
    let cancelled = false;

    const tryRender = () => {
      if (cancelled || !window.google || !googleBtn.current) return false;
      window.google.accounts.id.initialize({
        client_id: config.googleClientId,
        callback: async ({ credential }) => {
          setBusy(true);
          try {
            const { token, user } = await api.signInWithGoogle(credential);
            tokenStore.set(token);
            onSignedIn(user);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        },
      });
      window.google.accounts.id.renderButton(googleBtn.current, {
        theme: 'filled_black',
        size: 'large',
        shape: 'pill',
        text: 'continue_with',
      });
      return true;
    };

    if (tryRender()) return;
    const id = setInterval(() => {
      if (tryRender()) clearInterval(id);
    }, 200);
    setTimeout(() => clearInterval(id), 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [config, onSignedIn]);

  const devSignIn = async () => {
    if (!devName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { token, user } = await api.signInAsDev(devName.trim());
      tokenStore.set(token);
      onSignedIn(user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid h-screen-safe place-items-center px-6"
      style={{ background: 'radial-gradient(ellipse 80% 60% at 50% 30%, #1a1f33 0%, #0b0d16 55%, #07080f 100%)' }}>
      <div className="w-full max-w-sm text-center">
        <h1 className="text-5xl font-black italic tracking-tighter drop-shadow-[0_6px_20px_rgba(239,68,68,.25)]">
          NO <span className="text-uno-red">MERCY</span>
        </h1>
        <p className="mt-2 text-sm text-white/40">UNO with the boys, from anywhere.</p>

        <div className="mt-8 flex justify-center" ref={googleBtn} />

        {config?.devAuth && (
          <div className="panel mt-8 rounded-2xl border-dashed border-amber-400/25 p-4 text-left">
            <div className="text-[10px] font-bold uppercase tracking-wide text-amber-400">
              Development sign-in
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-white/35">
              Not available in production. Use it to try the game before Google OAuth is set up.
            </p>
            <div className="mt-3 flex gap-2">
              <input
                value={devName}
                onChange={(e) => setDevName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && devSignIn()}
                placeholder="your name"
                maxLength={24}
                className="field min-w-0 flex-1 px-3 py-2.5 text-sm"
              />
              <button
                type="button"
                onClick={devSignIn}
                disabled={busy || !devName.trim()}
                className="rounded-xl bg-amber-300 px-4 py-2.5 text-sm font-black text-slate-900 transition hover:brightness-110 active:scale-95 disabled:opacity-35"
              >
                Go
              </button>
            </div>
          </div>
        )}

        {error && <p className="mt-5 text-xs text-red-400">{error}</p>}
      </div>
    </div>
  );
}
