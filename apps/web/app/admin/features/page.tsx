import type { ClientRow } from '@/components/admin/ClientAssignments';
import { FeatureFlagsTable } from '@/components/admin/FeatureFlagsTable';
import { api } from '@/lib/api';

export default async function FeaturesPage() {
  const clients = await api<ClientRow[]>('/admin/clients', '/admin/features');
  return (
    <main>
      <h1>Feature flags</h1>
      <p className="lede">Switch owner screens on or off per business. Off hides the screen in both apps and the API refuses it.</p>
      <FeatureFlagsTable clients={clients} />
    </main>
  );
}
