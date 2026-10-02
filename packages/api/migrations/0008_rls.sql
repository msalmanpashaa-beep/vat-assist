-- Row-level security. The API connects as vat_app (not the owner, NOBYPASSRLS), so these policies apply to
-- every query it runs. Tenant isolation is enforced here even if application code forgets a WHERE clause.
grant select, insert, update on all tables in schema public to vat_app;
grant usage on all sequences in schema public to vat_app;
grant execute on all functions in schema app to vat_app;

-- Append-only tables: no updates, ever. Audit rows are written only through app.append_audit().
revoke update on journal_entries, journal_lines, allocations, query_messages, audit_events from vat_app;
revoke insert on audit_events from vat_app;
-- Deletes allowed only where a trigger still protects the data (drafts, re-imported reference data).
grant delete on lines, transactions, mra_registered_persons to vat_app;
-- Reference data is read-only for the API, except the MRA list importer.
revoke insert, update on vat_codes, vat_rules, public_holidays from vat_app;

do $$
declare t text;
begin
  foreach t in array array[
    'org_counters', 'accounts', 'contacts', 'vat_periods', 'documents', 'transactions', 'lines',
    'journal_entries', 'journal_lines', 'allocations', 'queries', 'query_messages', 'vat_returns',
    'subscriptions', 'outbound_messages'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I for all to vat_app
         using (org_id = any ((select app.scope_org_ids())::uuid[]))
         with check (org_id = any ((select app.scope_org_ids())::uuid[]))', t);
  end loop;
end $$;

alter table audit_events enable row level security;
create policy audit_read on audit_events for select to vat_app
  using (org_id = any ((select app.scope_org_ids())::uuid[]));

alter table organisations enable row level security;
create policy org_read on organisations for select to vat_app
  using (id = any ((select app.scope_org_ids())::uuid[]) or is_platform);
create policy org_update on organisations for update to vat_app
  using (id = any ((select app.scope_org_ids())::uuid[]) and app.has_role(id, array['owner', 'admin']))
  with check (id = any ((select app.scope_org_ids())::uuid[]));

alter table users enable row level security;
create policy users_read on users for select to vat_app using (
  id = app.current_user_id()
  or app.current_context() = 'auth'
  or exists (select 1 from memberships m
             where m.user_id = users.id and m.revoked_at is null and m.org_id = any ((select app.scope_org_ids())::uuid[]))
);
create policy users_update on users for update to vat_app
  using (id = app.current_user_id() or app.current_context() = 'auth')
  with check (id = app.current_user_id() or app.current_context() = 'auth');
create policy users_insert on users for insert to vat_app
  with check (app.current_context() = 'auth');

alter table memberships enable row level security;
create policy memberships_read on memberships for select to vat_app using (
  user_id = app.current_user_id()
  or org_id = any ((select app.scope_org_ids())::uuid[])
  or app.current_context() = 'auth'
);
-- Owners may add shop staff; only platform admins (via app.assign_staff) add reviewers.
create policy memberships_insert on memberships for insert to vat_app with check (
  org_id = any ((select app.scope_org_ids())::uuid[])
  and ((role = 'staff' and app.has_role(org_id, array['owner'])) or app.has_role(org_id, array['admin']))
);
create policy memberships_update on memberships for update to vat_app
  using (org_id = any ((select app.scope_org_ids())::uuid[]) and app.has_role(org_id, array['owner', 'admin']))
  with check (org_id = any ((select app.scope_org_ids())::uuid[]));

alter table bookings enable row level security;
create policy bookings_parties on bookings for all to vat_app
  using (org_id = any ((select app.scope_org_ids())::uuid[]) or platform_org_id = any ((select app.scope_org_ids())::uuid[]))
  with check (org_id = any ((select app.scope_org_ids())::uuid[]) or platform_org_id = any ((select app.scope_org_ids())::uuid[]));

alter table payments enable row level security;
create policy payments_parties on payments for all to vat_app
  using (org_id = any ((select app.scope_org_ids())::uuid[]) or payer_org_id = any ((select app.scope_org_ids())::uuid[]))
  with check (org_id = any ((select app.scope_org_ids())::uuid[]) or payer_org_id = any ((select app.scope_org_ids())::uuid[]));
