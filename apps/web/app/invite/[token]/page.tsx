'use client';
import { useRouter } from 'next/navigation';
import { type FormEvent, use, useState } from 'react';

type Step = { kind: 'password' } | { kind: 'code'; mfaToken: string; secret?: string; uri?: string } | { kind: 'codes'; codes: string[] };

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message ?? 'That did not work.');
  return data as T;
}

/** A Nex-Gen invite or password reset: choose a password, then set up (or use) the authenticator. */
export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [error, setError] = useState<string | null>(null);

  async function setPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const password = String(f.get('password'));
    if (password !== String(f.get('confirm'))) return setError('The two passwords are different.');
    try {
      setError(null);
      const r = await post<{ mfaToken: string; totpEnrolled: boolean }>('/api/auth/invite-accept', { token, password });
      if (r.totpEnrolled) return setStep({ kind: 'code', mfaToken: r.mfaToken });
      const s = await post<{ secret: string; otpauthUri: string }>('/api/auth/totp-setup', { mfaToken: r.mfaToken });
      setStep({ kind: 'code', mfaToken: r.mfaToken, secret: s.secret, uri: s.otpauthUri });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function verify(e: FormEvent<HTMLFormElement>, mfaToken: string) {
    e.preventDefault();
    try {
      setError(null);
      const r = await post<{ recoveryCodes: string[] | null }>('/api/auth/totp', { mfaToken, code: String(new FormData(e.currentTarget).get('code')).trim().toUpperCase() });
      if (r.recoveryCodes) setStep({ kind: 'codes', codes: r.recoveryCodes });
      else router.replace('/reviewer');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main className="shell" style={{ maxWidth: 460, paddingTop: '10vh' }}>
      <h1>Welcome to VAT Assist</h1>
      {error && <p className="msg err" role="alert">{error}</p>}
      {step.kind === 'password' && (
        <form onSubmit={setPassword}>
          <p className="lede">Choose a password of at least 12 characters. Next you set up an authenticator app.</p>
          <label className="field">New password<input name="password" type="password" autoComplete="new-password" minLength={12} required /></label>
          <label className="field">Repeat it<input name="confirm" type="password" autoComplete="new-password" minLength={12} required /></label>
          <button className="btn">Continue</button>
        </form>
      )}
      {step.kind === 'code' && (
        <form onSubmit={(e) => verify(e, step.mfaToken)}>
          {step.secret && (
            <div className="panel" style={{ marginBottom: '1rem' }}>
              <p>Add VAT Assist to your authenticator app with this key, then enter the 6-digit code.</p>
              <p style={{ wordBreak: 'break-all', fontWeight: 700 }}>{step.secret}</p>
              {step.uri && <p><a href={step.uri}>Open in authenticator app</a></p>}
            </div>
          )}
          <label className="field">Code from your authenticator<input name="code" inputMode="numeric" autoComplete="one-time-code" required /></label>
          <button className="btn">Sign in</button>
        </form>
      )}
      {step.kind === 'codes' && (
        <div className="panel">
          <p>Keep these recovery codes somewhere safe. Each works once if you lose your phone.</p>
          <ul>{step.codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
          <button className="btn" onClick={() => router.replace('/reviewer')}>I have saved them</button>
        </div>
      )}
    </main>
  );
}
