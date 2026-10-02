'use client';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';

interface QueryRow { id: string; status: string; blocking: boolean; first_message: string | null; last_message: string | null; message_count: number; automatic: boolean }
interface Message { id: string; body: string | null; author_name: string | null; from_reviewer: boolean; from_system: boolean; created_at: string }

/** Questions to and from the shop. Blocking questions stop sign-off until resolved. */
export function QueryPanel({ orgId, queries, canResolve }: { orgId: string; queries: QueryRow[]; canResolve: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [thread, setThread] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load(id: string) {
    setOpen(id);
    const res = await fetch(`/api/proxy/orgs/${orgId}/queries/${id}`);
    setThread(res.ok ? ((await res.json()) as { messages: Message[] }).messages : []);
  }
  async function post(path: string, body: unknown) {
    setError(null);
    const res = await fetch(`/api/proxy/orgs/${orgId}/queries${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) setError(((await res.json().catch(() => ({}))) as { message?: string }).message ?? 'Failed');
    router.refresh();
    return res.ok;
  }
  async function ask(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    if (await post('', { body: String(f.get('body')), blocking: f.get('blocking') === 'on' })) form.reset();
  }
  async function reply(e: FormEvent<HTMLFormElement>, id: string) {
    e.preventDefault();
    const form = e.currentTarget;
    if (await post(`/${id}/messages`, { body: String(new FormData(form).get('body')) })) {
      form.reset();
      await load(id);
    }
  }

  return (
    <div>
      {error && <p className="msg err" role="alert">{error}</p>}
      {queries.length === 0 && <p className="lede">No questions yet.</p>}
      {queries.map((q) => (
        <div key={q.id} className="panel" style={{ marginBottom: 8 }}>
          <button className="btn quiet" style={{ border: 0, padding: 0, textAlign: 'left' }} onClick={() => (open === q.id ? setOpen(null) : load(q.id))}>
            {q.first_message ?? 'Question'}
          </button>
          <div className="track-label">
            {q.status.replace('_', ' ')}{q.blocking ? ', blocks sign-off' : ''}{q.automatic ? ', raised automatically' : ''}, {q.message_count} message(s)
          </div>
          {open === q.id && (
            <div style={{ marginTop: 8 }}>
              {thread.map((m) => (
                <p key={m.id} style={{ margin: '0.4rem 0' }}>
                  <strong>{m.from_system ? 'VAT Assist' : (m.author_name ?? (m.from_reviewer ? 'Reviewer' : 'Shop'))}:</strong> {m.body}
                </p>
              ))}
              {['open', 'answered'].includes(q.status) && (
                <form onSubmit={(e) => reply(e, q.id)} style={{ display: 'flex', gap: 8 }}>
                  <input name="body" required placeholder="Reply" style={{ flex: 1 }} className="field" />
                  <button className="btn quiet">Send</button>
                  {canResolve && <button type="button" className="btn" onClick={() => post(`/${q.id}/resolve`, {})}>Resolve</button>}
                </form>
              )}
            </div>
          )}
        </div>
      ))}
      <form onSubmit={ask} className="panel">
        <label className="field">Ask the shop a question<textarea name="body" required rows={2} /></label>
        <label style={{ display: 'flex', gap: 8, marginBottom: 10 }}><input type="checkbox" name="blocking" defaultChecked /> Blocks sign-off until resolved</label>
        <button className="btn">Send question</button>
      </form>
    </div>
  );
}
