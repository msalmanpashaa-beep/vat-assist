'use client';
import { type FeatureSet, WHATSAPP_CONSENT } from '@vat-assist/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { when } from '@/lib/format';
import { send } from '@/lib/post';

export interface OwnerSettings {
  debtorRemindersEnabled: boolean; scheduledInvoiceReminders: number; whatsappOptIn: boolean;
  whatsappConsentVersion: string | null; currentConsentVersion: string;
}

/** Customer invoice reminders (schedules or cancels the messages) and the owner's own WhatsApp consent. */
export function SettingsForm({ orgId, settings, features, scheduled }: {
  orgId: string; settings: OwnerSettings; features: FeatureSet; scheduled: Array<{ id: string; to_e164: string; scheduled_for: string }>;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(work: () => Promise<string>) {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await work() });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const toggleReminders = () =>
    run(async () => {
      const r = await send<{ scheduled: number; cancelled: number }>('PATCH', `/orgs/${orgId}/settings`, { debtorRemindersEnabled: !settings.debtorRemindersEnabled });
      return settings.debtorRemindersEnabled ? `Reminders off: ${r.cancelled} scheduled reminder(s) cancelled.` : `Reminders on: ${r.scheduled} reminder(s) scheduled.`;
    });
  const consent = (optIn: boolean) =>
    run(async () => {
      await send('POST', `/orgs/${orgId}/whatsapp-consent`, { optIn, consentVersion: WHATSAPP_CONSENT.version });
      return optIn ? 'WhatsApp turned on. Reply STOP to any message to end it.' : 'WhatsApp turned off. Reminders come by SMS.';
    });

  return (
    <div>
      {msg && <p className={`msg ${msg.ok ? 'ok' : 'err'}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
      <section className="panel" style={{ marginBottom: '1rem' }}>
        <h2 style={{ marginTop: 0 }}>Customer invoice reminders</h2>
        {!features.invoice_reminders ? (
          <p className="lede">Not available for this business. Ask Nex-Gen to switch it on.</p>
        ) : (
          <>
            <label className="switch">
              <input type="checkbox" checked={settings.debtorRemindersEnabled} onChange={toggleReminders} disabled={busy} />
              <span>Text customers the day before an invoice is due. Only customers who agreed, and only while something is still owed.</span>
            </label>
            <p className="track-label">{settings.scheduledInvoiceReminders} reminder(s) scheduled</p>
            {scheduled.length > 0 && (
              <ul>{scheduled.map((s) => <li key={s.id}>{s.to_e164}, {when(s.scheduled_for)}</li>)}</ul>
            )}
          </>
        )}
      </section>
      <section className="panel">
        <h2 style={{ marginTop: 0 }}>WhatsApp messages</h2>
        {!features.whatsapp_opt_in ? (
          <p className="lede">Not available for this business.</p>
        ) : settings.whatsappOptIn ? (
          <>
            <p>Your reminders come on WhatsApp (agreed to version {settings.whatsappConsentVersion}).</p>
            <button className="btn quiet" onClick={() => consent(false)} disabled={busy}>Stop WhatsApp messages</button>
          </>
        ) : (
          <>
            <p>{WHATSAPP_CONSENT.text.en}</p>
            <button className="btn" onClick={() => consent(true)} disabled={busy}>I agree, use WhatsApp</button>
          </>
        )}
      </section>
    </div>
  );
}
