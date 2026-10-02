-- Append-only, hash-chained audit trail, one chain per organisation.
-- hash_n = sha256(prev_hash | org | seq | time | actor | context | action | entity | data)
create table audit_events (
  id             bigint generated always as identity primary key,
  org_id         uuid not null references organisations (id),
  seq            bigint not null,
  occurred_at    timestamptz not null,
  actor_user_id  uuid,
  actor_context  text not null,
  action         text not null,
  entity_type    text not null,
  entity_id      text,
  data           jsonb,
  prev_hash      text not null,
  hash           text not null,
  unique (org_id, seq)
);
create trigger audit_events_immutable before update or delete on audit_events for each row execute function app.forbid_mutation();
create trigger audit_events_no_truncate before truncate on audit_events for each statement execute function app.forbid_mutation();

create or replace function app.audit_payload(p_prev text, p_org uuid, p_seq bigint, p_at timestamptz, p_actor uuid,
                                             p_ctx text, p_action text, p_type text, p_id text, p_data jsonb)
returns text language sql stable as $$
  select concat_ws('|', p_prev, p_org::text, p_seq::text,
                   to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                   coalesce(p_actor::text, '-'), p_ctx, p_action, p_type, coalesce(p_id, '-'),
                   coalesce(p_data::text, 'null'))
$$;

-- The only way to write an audit event. Serialised per organisation with an advisory lock.
create or replace function app.append_audit(p_action text, p_entity_type text, p_entity_id text, p_data jsonb)
returns bigint
language plpgsql security definer set search_path = public, app as $$
declare
  v_org   uuid := app.current_org_id();
  v_seq   bigint;
  v_prev  text;
  v_at    timestamptz := clock_timestamp();
  v_hash  text;
  v_id    bigint;
begin
  if v_org is null then raise exception 'audit_requires_org_context' using errcode = 'P0001'; end if;
  if not (v_org = any (app.scope_org_ids())) then raise exception 'audit_org_not_in_scope' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('audit:' || v_org::text, 0));
  select seq, hash into v_seq, v_prev from audit_events where org_id = v_org order by seq desc limit 1;
  v_seq := coalesce(v_seq, 0) + 1;
  v_prev := coalesce(v_prev, repeat('0', 64));
  v_hash := encode(digest(app.audit_payload(v_prev, v_org, v_seq, v_at, app.current_user_id(), app.current_context(),
                                            p_action, p_entity_type, p_entity_id, p_data), 'sha256'), 'hex');
  insert into audit_events (org_id, seq, occurred_at, actor_user_id, actor_context, action, entity_type, entity_id, data, prev_hash, hash)
  values (v_org, v_seq, v_at, app.current_user_id(), app.current_context(), p_action, p_entity_type, p_entity_id, p_data, v_prev, v_hash)
  returning id into v_id;
  return v_id;
end $$;

create or replace function app.verify_audit_chain(p_org uuid)
returns table (ok boolean, checked bigint, first_bad_seq bigint)
language plpgsql stable security definer set search_path = public, app as $$
declare
  r       record;
  v_prev  text := repeat('0', 64);
  v_n     bigint := 0;
begin
  if not (p_org = any (app.scope_org_ids())) then raise exception 'org_not_in_scope' using errcode = '42501'; end if;
  for r in select * from audit_events where org_id = p_org order by seq loop
    v_n := v_n + 1;
    if r.seq <> v_n or r.prev_hash <> v_prev
       or r.hash <> encode(digest(app.audit_payload(r.prev_hash, r.org_id, r.seq, r.occurred_at, r.actor_user_id,
                                                    r.actor_context, r.action, r.entity_type, r.entity_id, r.data), 'sha256'), 'hex') then
      return query select false, v_n, r.seq;
      return;
    end if;
    v_prev := r.hash;
  end loop;
  return query select true, v_n, null::bigint;
end $$;
