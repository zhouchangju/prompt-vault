-- Read-only installation checks. Safe to run in Supabase SQL Editor after setup.
-- All rows should say PASS. This does not log in or upload any prompt data.
select 'schema_version' as check_name,
  case when (select schema_version from prompt_vault.sync_state where singleton) = 3 then 'PASS' else 'FAIL' end as result
union all
select 'rls_enabled_on_all_4_tables', case when (
  select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='prompt_vault' and c.relname in ('sync_state','entities','sync_changes','sync_receipts') and c.relrowsecurity
) = 4 then 'PASS' else 'FAIL' end
union all
select 'anon_rpc_execute', case when
  has_function_privilege('anon','public.pv_sync_status()','EXECUTE') and
  has_function_privilege('anon','public.pv_sync_push(jsonb)','EXECUTE') and
  has_function_privilege('anon','public.pv_sync_pull(text,integer,text)','EXECUTE') then 'PASS' else 'FAIL' end
union all
select 'authenticated_rpc_denied', case when not (
  has_function_privilege('authenticated','public.pv_sync_status()','EXECUTE') or
  has_function_privilege('authenticated','public.pv_sync_push(jsonb)','EXECUTE') or
  has_function_privilege('authenticated','public.pv_sync_pull(text,integer,text)','EXECUTE')) then 'PASS' else 'FAIL' end
union all
select 'client_direct_access_denied', case when not exists (
  select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
  cross join (values ('anon'),('authenticated')) as roles(role_name)
  where n.nspname='prompt_vault' and c.relkind='r'
    and has_table_privilege(roles.role_name,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
) then 'PASS' else 'FAIL' end
union all
select 'private_helpers_denied', case when not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  cross join (values ('anon'),('authenticated')) as roles(role_name)
  where n.nspname='prompt_vault' and has_function_privilege(roles.role_name,p.oid,'EXECUTE')
) then 'PASS' else 'FAIL' end
union all
select 'single_vault_state', case when (select count(*) from prompt_vault.sync_state) = 1
  then 'PASS' else 'FAIL' end
union all
select 'no_account_columns', case when not exists (
  select 1 from information_schema.columns where table_schema='prompt_vault'
    and column_name in ('user_id','tenant_id','owner_id')
) then 'PASS' else 'FAIL' end;
