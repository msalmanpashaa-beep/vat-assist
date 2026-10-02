'use client';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';

type Step = { kind: 'password' } | { kind: 'code'; mfaToken: string } | { kind: 'enrol'; mfaToken: string; secret: string; uri: string } | { kind: 'recovery'; codes: string[] };

export default function StaffLogin() {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function post(url: string, body: unknown) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message ?? 'Sign-in failed.');
    return data;
  }

  async function onPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const r = await post('/api/auth/staff-login', { email: f.get('email'), password: f.get('password') });
      if (r.totpEnrolled) setStep({ kind: 'code', mfaToken: r.mfaToken });
      else {
        const s = await post('/api/auth/totp-setup', { mfaToken: r.mfaToken });
        setStep({ kind: 'enrol', mfaToken: r.mfaToken, secret: s.secret, uri: s.otpauthUri });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onCode(e: FormEvent<HTMLFormElement>, mfaToken: string) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code') ?? '').trim().toUpperCase();
    setBusy(true);
    setError(null);
    try {
      const r = await post('/api/auth/totp', { mfaToken, code });
      if (r.recoveryCodes) setStep({ kind: 'recovery', codes: r.recoveryCodes });
      else router.replace('/reviewer');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell" style={{ maxWidth: 440, paddingTop: '12vh' }}>
      <h1>Reviewer sign-in</h1>
      <p className="lede">For Nex-Gen staff. Shop owners sign in with their phone on the app or at <a href="/owner/login">owner sign-in</a>.</p>
      {error && <p className="msg err" role="alert">{error}</p>}
      {step.kind === 'password' && (
        <form onSubmit={onPassword}>
          <label className="field">Email<input name="email" type="email" autoComplete="username" required /></label>
          <label className="field">Password<input name="password" type="password" autoComplete="current-password" required minLength={12} /></label>
          <button className="btn" disabled={busy}>Continue</button>
        </form>
      )}
      {(step.kind === 'code' || step.kind === 'enrol') && (
        <form onSubmit={(e) => onCode(e, step.mfaToken)}>
          {step.kind === 'enrol' && (
            <div className="panel" style={{ marginBottom: '1rem' }}>
              <p>Add VAT Assist to your authenticator app with this key, then enter the 6-digit code it shows.</p>
              <p style={{ wordBreak: 'break-all', fontWeight: 700 }}>{step.secret}</p>
              <p><a href={step.uri}>Open in authenticator app</a></p>
            </div>
          )}
          <label className="field">
            Code from your authenticator app
            <input name="code" inputMode="numeric" autoComplete="one-time-code" required pattern="(\d{6}|[A-Za-z0-9]{5}-[A-Za-z0-9]{5})" />
            <small>Lost your phone? Enter one of your recovery codes instead.</small>
          </label>
          <button className="btn" disabled={busy}>Sign in</button>
        </form>
      )}
      {step.kind === 'recovery' && (
        <div className="panel">
          <p>Keep these recovery codes somewhere safe. Each one works once if you lose your authenticator.</p>
          <ul>{step.codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
          <button className="btn" onClick={() => router.replace('/reviewer')}>I have saved them</button>
        </div>
      )}
    </main>
  );
}
