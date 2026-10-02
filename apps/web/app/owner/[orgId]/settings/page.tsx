import type { FeatureSet } from '@vat-assist/shared';
import { SettingsForm, type OwnerSettings } from '@/components/owner/SettingsForm';
import { api } from '@/lib/api';

export default async function SettingsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const back = `/owner/${orgId}/settings`;
  const [settings, features, queued] = await Promise.all([
    api<OwnerSettings>(`/orgs/${orgId}/settings`, back),
    api<FeatureSet>(`/orgs/${orgId}/features`, back),
    api<Array<{ id: string; template_key: string; to_e164: string; scheduled_for: string }>>(`/orgs/${orgId}/reminders?status=queued`, back),
  ]);
  return (
    <main className="shell">
      <h1>Settings</h1>
      <SettingsForm orgId={orgId} settings={settings} features={features} scheduled={queued.filter((q) => q.template_key === 'invoice_due_tomorrow')} />
    </main>
  );
}
