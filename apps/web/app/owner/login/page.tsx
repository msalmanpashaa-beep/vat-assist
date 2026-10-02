'use client';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';

export default function OwnerLogin() {
  const router = useRouter();
  const [phone, setPhone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function post(url: string, body: unknown) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message ?? 'That did not work.');
  }

  async function sendCode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const p = String(new FormData(e.currentTarget).get('phone'));
    try {
      setError(null);
      await post('/api/auth/otp-start', { phone: p });
      setPhone(p);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function verify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      setError(null);
      await post('/api/auth/otp-verify', { phone, code: String(new FormData(e.currentTarget).get('code')) });
      router.replace('/owner');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main className="shell" style={{ maxWidth: 440, paddingTop: '12vh' }}>
      <h1>Sign in to your shop</h1>
      {error && <p className="msg err" role="alert">{error}</p>}
      {!phone ? (
        <form onSubmit={sendCode}>
          <label className="field">Mobile number<input name="phone" type="tel" inputMode="tel" placeholder="5712 3456" required /></label>
          <button className="btn">Send me a code</button>
        </form>
      ) : (
        <form onSubmit={verify}>
          <label className="field">Code sent by SMS to {phone}<input name="code" inputMode="numeric" autoComplete="one-time-code" required /></label>
          <button className="btn">Sign in</button>
        </form>
      )}
    </main>
  );
}
