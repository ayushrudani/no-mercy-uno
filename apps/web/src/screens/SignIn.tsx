/**
 * Sign in, sign up, and the forced first password change.
 *
 * All three are one screen because they are one flow: signing up hands back a
 * reset token rather than a session, so a new account walks straight into the
 * "choose a password" step without ever seeing the lobby. Logging in with an
 * account that has not done that step yet lands in exactly the same place.
 *
 * The reset token lives in component state and nowhere else -- not in
 * localStorage, not in a cookie. It authorises one call and expires in minutes,
 * and keeping it out of storage means a half-finished signup cannot be resumed
 * days later from a stale tab.
 */

import { useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { api, tokenStore, type AuthResult, type Profile } from '../lib/api.js';

type Mode = 'signin' | 'signup';

const MIN_PASSWORD = 8;

export function SignIn({ onSignedIn }: { onSignedIn: (p: Profile) => void }) {
  const [mode, setMode] = useState<Mode>('signin');
  const [pending, setPending] = useState<AuthResult | null>(null);

  if (pending) {
    return (
      <Shell subtitle={`Welcome, ${pending.user.displayName}.`}>
        <ChoosePassword
          result={pending}
          onDone={onSignedIn}
          onCancel={() => {
            setPending(null);
            setMode('signin');
          }}
        />
      </Shell>
    );
  }

  return (
    <Shell subtitle="UNO with the boys, from anywhere.">
      <div className="mb-5 flex rounded-xl bg-white/5 p-1 ring-1 ring-white/8">
        <Tab active={mode === 'signin'} onClick={() => setMode('signin')}>
          Sign in
        </Tab>
        <Tab active={mode === 'signup'} onClick={() => setMode('signup')}>
          Create account
        </Tab>
      </div>

      {mode === 'signin' ? (
        <SignInForm
          onResult={(r) => (r.mustResetPassword ? setPending(r) : finish(r, onSignedIn))}
        />
      ) : (
        <SignUpForm onResult={setPending} />
      )}
    </Shell>
  );
}

/** Store the session and hand the profile up. Only ever called with a real session. */
function finish(result: AuthResult, onSignedIn: (p: Profile) => void) {
  tokenStore.set(result.token);
  onSignedIn(result.user);
}

// ---------------------------------------------------------------------------

function SignInForm({ onResult }: { onResult: (r: AuthResult) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useSubmit();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => onResult(await api.signIn(username.trim().toLowerCase(), password)));
  };

  return (
    <form onSubmit={submit} className="space-y-3 text-left">
      <Field
        label="Username"
        value={username}
        onChange={setUsername}
        autoComplete="username"
        placeholder="yourname"
      />
      <Field
        label="Password"
        value={password}
        onChange={setPassword}
        type="password"
        autoComplete="current-password"
      />
      <ErrorNote message={error} />
      <Submit busy={busy} disabled={!username.trim() || !password}>
        Sign in
      </Submit>
    </form>
  );
}

function SignUpForm({ onResult }: { onResult: (r: AuthResult) => void }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const { busy, error, run } = useSubmit();

  const clean = username.trim().toLowerCase();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () =>
      onResult(
        await api.signUp({
          username: clean,
          password,
          code: code.trim(),
          ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        }),
      ),
    );
  };

  return (
    <form onSubmit={submit} className="space-y-3 text-left">
      <Field
        label="Username"
        value={username}
        onChange={setUsername}
        autoComplete="username"
        placeholder="lowercase, 3-20 characters"
        hint="Letters, numbers, _ and . only."
      />
      <Field
        label="Display name"
        value={displayName}
        onChange={setDisplayName}
        autoComplete="nickname"
        placeholder="shown at the table (optional)"
        maxLength={24}
      />
      <Field
        label="Password"
        value={password}
        onChange={setPassword}
        type="password"
        autoComplete="new-password"
        hint={`At least ${MIN_PASSWORD} characters. You will pick a new one straight after.`}
      />
      <Field
        label="Signup code"
        value={code}
        onChange={setCode}
        autoComplete="off"
        placeholder="ask whoever runs the server"
      />
      <ErrorNote message={error} />
      <Submit busy={busy} disabled={!clean || password.length < MIN_PASSWORD || !code.trim()}>
        Create account
      </Submit>
    </form>
  );
}

/**
 * The forced change.
 *
 * Confirming twice is worth the extra field here specifically: get it wrong and
 * you are locked out of an account that is minutes old, with nobody to reset it
 * for you.
 */
function ChoosePassword({
  result,
  onDone,
  onCancel,
}: {
  result: AuthResult;
  onDone: (p: Profile) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const { busy, error, run } = useSubmit();

  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = password.length >= MIN_PASSWORD && confirm === password;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    void run(async () => finish(await api.resetPassword(result.token, password), onDone));
  };

  return (
    <form onSubmit={submit} className="space-y-3 text-left">
      <p className="rounded-xl bg-amber-400/10 px-3 py-2.5 text-[11px] leading-relaxed text-amber-200/80 ring-1 ring-amber-400/20">
        Set a password of your own before you can play. The one you just used was only good for
        getting this far.
      </p>
      <Field
        label="New password"
        value={password}
        onChange={setPassword}
        type="password"
        autoComplete="new-password"
        hint={`At least ${MIN_PASSWORD} characters.`}
      />
      <Field
        label="Confirm password"
        value={confirm}
        onChange={setConfirm}
        type="password"
        autoComplete="new-password"
        {...(mismatch ? { hint: 'These do not match.', hintTone: 'error' as const } : {})}
      />
      <ErrorNote message={error} />
      <Submit busy={busy} disabled={!ready}>
        Save and play
      </Submit>
      <button
        type="button"
        onClick={onCancel}
        className="w-full text-center text-[11px] text-white/30 underline decoration-white/15 transition hover:text-white/60"
      >
        back
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/** One busy flag and one error string; every form here needs exactly that. */
function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, run };
}

function Shell({ subtitle, children }: { subtitle: string; children: ReactNode }) {
  return (
    <div
      className="grid h-screen-safe place-items-center overflow-y-auto px-6 py-8"
      style={{
        background:
          'radial-gradient(ellipse 80% 60% at 50% 30%, #1a1f33 0%, #0b0d16 55%, #07080f 100%)',
      }}
    >
      <div className="w-full max-w-sm text-center">
        <h1 className="text-5xl font-black italic tracking-tighter drop-shadow-[0_6px_20px_rgba(239,68,68,.25)]">
          NO <span className="text-uno-red">MERCY</span>
        </h1>
        <p className="mt-2 mb-7 text-sm text-white/40">{subtitle}</p>
        {children}
      </div>
    </div>
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-lg px-3 py-2 text-xs font-bold transition ${
        active ? 'bg-white/10 text-white shadow-sm' : 'text-white/40 hover:text-white/70'
      }`}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
  hint,
  hintTone = 'muted',
  ...input
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  hintTone?: 'muted' | 'error';
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium text-white/45">{label}</span>
      <input
        {...input}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="field mt-1 w-full px-3 py-2.5 text-sm"
      />
      {hint && (
        <span
          className={`mt-1 block text-[10px] ${
            hintTone === 'error' ? 'text-red-400' : 'text-white/28'
          }`}
        >
          {hint}
        </span>
      )}
    </label>
  );
}

function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300 ring-1 ring-red-500/20">
      {message}
    </p>
  );
}

function Submit({
  busy,
  disabled,
  children,
}: {
  busy: boolean;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={busy || disabled}
      className="w-full rounded-xl bg-amber-300 px-4 py-3 text-sm font-black text-slate-900 transition hover:brightness-110 active:scale-[.98] disabled:opacity-35 disabled:active:scale-100"
    >
      {busy ? 'working…' : children}
    </button>
  );
}
