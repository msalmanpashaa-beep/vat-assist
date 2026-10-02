import { type ClientRow, ClientAssignments } from '@/components/admin/ClientAssignments';
import type { StaffRow } from '@/components/admin/StaffAdmin';
import { api } from '@/lib/api';

export default async function ClientsPage() {
  const [clients, staff] = await Promise.all([api<ClientRow[]>('/admin/clients', '/admin/clients'), api<StaffRow[]>('/admin/staff', '/admin/clients')]);
  return (
    <main>
      <h1>Clients and reviewers</h1>
      <p className="lede">Who reviews which business. Select several to move them in one go, for example when a reviewer leaves.</p>
      <ClientAssignments clients={clients} staff={staff.filter((s) => !s.disabled && !s.invite_pending)} />
    </main>
  );
}
