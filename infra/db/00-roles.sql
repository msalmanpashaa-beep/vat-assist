-- Development roles. In production create these with secrets from your vault, never with these passwords.
-- vat_owner owns the schema and runs migrations. vat_app is what the API uses: it is NOT the table owner
-- and has NOBYPASSRLS, so every tenant table's row-level security policies apply to it.
create role vat_owner login password 'vat_owner_dev';
create role vat_app login password 'vat_app_dev' nobypassrls;
grant all privileges on database vat_assist to vat_owner;
alter database vat_assist owner to vat_owner;
