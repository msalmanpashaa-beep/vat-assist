'use client';
import { STAFF_ROLES, validateStaffInvite } from '@vat-assist/shared';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { send } from '@/lib/post';

export interface StaffRow {
  user_id: string; email: string; full_name: string | null; roles: string[] | null; totp_enabled: boolean; disabled: boolean;
  invite_pending: boolean; recovery_codes_left: number; client_count: number;
  invite_email?: { status: 'sent' | 'failed'; provider: string; error: string | null; at: string } | null;
}

interface InviteResult { inviteUrl: string | null; email: { status: 'sent' | 'failed'; provider: string; error: string | null } }
const PROVIDER_LABEL: Record<string, string> = { console: 'the development outbox', smtp: 'your mail server (SMTP)', postmark: 'Postmark', resend: 'Resend', m365: 'Microsoft 365' };

/** Emailed: say so, show no link. Not emailed: say why and give the admin the link to pass on. */
function inviteOutcome(to: string, r: InviteResult, extra = ''): { title: string; value: string | null } {
  if (r.email.status === 'sent') {
    return { title: `Invite emailed to ${to} via ${PROVIDER_LABEL[r.email.provider] ?? r.email.provider}${extra}. The link works once and expires in 7 days.`, value: null };
  }
  return { title: `The email to ${to} could not be sent (${r.email.error ?? 'unknown error'}). Send them this link another way${extra}:`, value: r.inviteUrl };
}

function inviteState(s: StaffRow): string {
  const m = s.invite_email;
  if (!m) return 'Invited, not signed in yet';
  if (m.status === 'failed') return `Invite email failed: ${m.error ?? 'unknown error'}`;
  return `Invite emailed ${new Date(m.at).toLocaleDateString('en-GB')}, not accepted yet`;
}

const ROLE_LABEL: Record<string, string> = { reviewer: 'Reviewer', senior_reviewer: 'Senior reviewer (signs off)', admin: 'Admin', support: 'Support' };

export function StaffAdmin({ staff, clients = [] }: { staff: StaffRow[]; clients?: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<string>('reviewer');
  const [orgIds, setOrgIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [reveal, setReveal] = useState<{ title: string; value: string | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function act(key: string, work: () => Promise<{ title: string; value: string | null } | null>) {
    setBusy(key);
    setErrors([]);
    try {
      setReveal(await work());
      router.refresh();
    } catch (e) {
      setErrors([(e as Error).message]);
    } finally {
      setBusy(null);
    }
  }

  async function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const problems = validateStaffInvite({ email, fullName, role });
    if (problems.length) return setErrors(problems);
    await act('invite', async () => {
      const r = await send<InviteResult>('POST', '/admin/staff', { email: email.trim(), fullName: fullName.trim(), role, orgIds });
      setEmail('');
      setFullName('');
      setOrgIds([]);
      const linked = orgIds.length ? `, linked to ${orgIds.length} client${orgIds.length > 1 ? 's' : ''}` : '';
      return inviteOutcome(email.trim(), r, linked);
    });
  }

  return (
    <div>
      {errors.map((m) => <p key={m} className="msg err" role="alert">{m}</p>)}
      {reveal && (
        <div className="reveal" role="status">
          <strong>{reveal.title}</strong>
          {reveal.value && (
            <>
              <div style={{ marginTop: 6, wordBreak: 'break-all' }}>{reveal.value}</div>
              <button className="btn quiet" style={{ marginTop: 8 }} onClick={() => navigator.clipboard?.writeText(reveal.value ?? '')}>Copy</button>
            </>
          )}
        </div>
      )}
      <p style={{ margin: '0 0 1rem' }}>
        <button className="btn quiet" disabled={!!busy} onClick={() => act('test-email', async () => {
          const r = await send<{ to: string; status: 'sent' | 'failed'; provider: string; error: string | null }>('POST', '/admin/mail/test', {});
          return r.status === 'sent'
            ? { title: `Test email sent to ${r.to} via ${PROVIDER_LABEL[r.provider] ?? r.provider}. Check the inbox and the spam folder.`, value: null }
            : { title: `The test email to ${r.to} failed: ${r.error ?? 'unknown error'}`, value: null };
        })}>{busy === 'test-email' ? 'Sending…' : 'Send a test email to me'}</button>
      </p>
      <form onSubmit={invite} className="panel" aria-label="Invite staff" style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ marginTop: 0 }}>Invite someone</h2>
        <div className="row-grid">
          <label className="field">Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="field">Full name<input value={fullName} onChange={(e) => setFullName(e.target.value)} /></label>
          <label className="field">Role
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              {STAFF_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </label>
          {clients.length > 0 && (
            <fieldset className="field" style={{ border: 0, padding: 0, margin: '0 0 0.9rem' }}>
              <legend>Link to clients now (optional)</legend>
              <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 'var(--radius-s)', padding: '0.4rem 0.6rem' }}>
                {clients.map((c) => (
                  <label key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input type="checkbox" checked={orgIds.includes(c.id)}
                      onChange={(e) => setOrgIds(e.target.checked ? [...orgIds, c.id] : orgIds.filter((x) => x !== c.id))} />
                    {c.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
        </div>
        <button className="btn" disabled={busy === 'invite'}>{busy === 'invite' ? 'Sending…' : 'Send invite'}</button>
      </form>
      <table className="grid">
        <thead><tr><th>Person</th><th>Role</th><th>Sign-in</th><th className="num">Clients</th><th>Actions</th></tr></thead>
        <tbody>
          {staff.map((s) => (
            <tr key={s.user_id}>
              <td>{s.full_name ?? s.email}<div className="track-label">{s.email}</div></td>
              <td>{(s.roles ?? []).map((r) => ROLE_LABEL[r] ?? r).join(', ')}</td>
              <td>
                {s.disabled ? 'Disabled' : s.invite_pending ? inviteState(s) : s.totp_enabled ? `Authenticator on (${s.recovery_codes_left} recovery codes)` : 'Must set up authenticator'}
              </td>
              <td className="num">{s.client_count}</td>
              <td>
                <div className="row-actions">
                  <button className="btn quiet" disabled={!!busy} onClick={() => act(`link-${s.user_id}`, async () => {
                    const r = await send<InviteResult>('POST', `/admin/staff/${s.user_id}/invite`);
                    return inviteOutcome(s.email, r, ' (it sets a new password)');
                  })}>Resend invite</button>
                  <button className="btn quiet" disabled={!!busy} onClick={() => window.confirm(`Reset two-factor sign-in for ${s.email}? They set up a new authenticator next time, and are signed out everywhere.`) && act(`2fa-${s.user_id}`, async () => {
                    await send('POST', `/admin/staff/${s.user_id}/reset-2fa`);
                    return { title: `Two-factor reset for ${s.email}`, value: 'They will set up a new authenticator at their next sign-in.' };
                  })}>Reset 2FA</button>
                  <button className="btn quiet" disabled={!!busy || !s.totp_enabled} onClick={() => act(`code-${s.user_id}`, async () => {
                    const r = await send<{ code: string }>('POST', `/admin/staff/${s.user_id}/recovery-code`);
                    return { title: `One-time recovery code for ${s.email}. Shown once; give it to them by phone.`, value: r.code };
                  })}>Recovery code</button>
                  <button className={`btn ${s.disabled ? 'quiet' : 'danger'}`} disabled={!!busy} onClick={() => act(`dis-${s.user_id}`, async () => {
                    await send('POST', `/admin/staff/${s.user_id}/${s.disabled ? 'enable' : 'disable'}`);
                    return null;
                  })}>{s.disabled ? 'Enable' : 'Disable'}</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
