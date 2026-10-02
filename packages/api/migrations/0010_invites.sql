-- Owners add shop staff (cashiers) by phone. SECURITY DEFINER because the invitee may not exist yet,
-- and users can only be created in 'auth' context otherwise.
create or replace function app.invite_shop_staff(p_org uuid, p_phone text, p_name text, p_locale text) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare v_user uuid; v_method text;
begin
  if not app.has_role(p_org, array['owner']) then
    raise exception 'only_owners_can_invite' using errcode = '42501';
  end if;
  select id, auth_method into v_user, v_method from users where phone_e164 = p_phone;
  if v_user is null then
    insert into users (auth_method, phone_e164, full_name, locale)
    values ('phone_otp', p_phone, p_name, coalesce(p_locale, 'en')) returning id into v_user;
  elsif v_method <> 'phone_otp' then
    raise exception 'this number belongs to a staff login' using errcode = 'P0001';
  end if;
  insert into memberships (org_id, user_id, role) values (p_org, v_user, 'staff')
  on conflict (org_id, user_id, role) where revoked_at is null do nothing;
  return v_user;
end $$;
grant execute on function app.invite_shop_staff(uuid, text, text, text) to vat_app;
