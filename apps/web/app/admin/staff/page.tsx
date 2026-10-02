import { type StaffRow, StaffAdmin } from '@/components/admin/StaffAdmin';
import { api } from '@/lib/api';

export default async function StaffPage() {
  const [staff, clientRows] = await Promise.all([
    api<StaffRow[]>('/admin/staff', '/admin/staff'),
    api<Array<Record<string, unknown>>>('/admin/clients', '/admin/staff'),
  ]);
  const clients = clientRows.map((c) => ({ id: String(c.org_id ?? c.id), name: String(c.org_name ?? c.name ?? c.legal_name ?? '') }));
  return (
    <main>
      <h1>Staff</h1>
      <p className="lede">Invite reviewers by email, and manage how they sign in. Every action is recorded in the audit trail.</p>
      <StaffAdmin staff={staff} clients={clients} />
    </main>
  );
}
