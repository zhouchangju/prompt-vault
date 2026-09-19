-- Prompt Vault: personal-project schema v3, sync protocol v1.
-- URL + publishable/legacy anon key, no Auth users or login required.
-- Anyone holding a working project publishable/anon key can read/write this vault
-- through the RPCs. Keep this project dedicated and its configuration private.
-- No project URL, API key, password, scheduled job or Realtime subscription.
-- This installer owns only prompt_vault.* and public.pv_sync_*.
-- Rerunning THIS version preserves data. Future versions require migrations.
begin;
set local lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon')
    or not exists (select 1 from pg_roles where rolname = 'authenticated') then
    raise exception 'Supabase API roles are required';
  end if;
  if exists (select 1 from pg_namespace where nspname = 'prompt_vault') then
    if to_regclass('prompt_vault.schema_info') is not null then
      raise exception 'Legacy multi-user schema detected; migration required. Existing data was not changed.';
    end if;
    if to_regclass('prompt_vault.sync_state') is null then
      raise exception 'Existing prompt_vault schema is not a personal-project installation';
    end if;
    if not exists (select 1 from prompt_vault.sync_state where singleton and schema_version = 3) then
      raise exception 'Unsupported Prompt Vault schema version; use a migration';
    end if;
  elsif exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('pv_sync_status', 'pv_sync_push', 'pv_sync_pull')
  ) then
    raise exception 'Reserved public.pv_sync_* function name already in use';
  end if;
end $$;

create schema if not exists prompt_vault;
revoke all on schema prompt_vault from public, anon, authenticated;
-- A single row holds installation metadata and the transactional cursor.
-- This is a private deployment, not an account/tenant registry.
create table if not exists prompt_vault.sync_state (
  singleton boolean primary key default true check (singleton),
  schema_version integer not null default 3 check (schema_version = 3),
  cursor bigint not null default 0 check (cursor >= 0)
);
insert into prompt_vault.sync_state(singleton) values (true) on conflict do nothing;

-- Prompt and folder bodies share a version/tombstone envelope. JSON bodies are
-- validated by the ONLY client write path, pv_sync_push, below.
create table if not exists prompt_vault.entities (
  entity_type text not null check (entity_type in ('prompt', 'folder')),
  id text not null check (octet_length(id) between 1 and 512 and btrim(id) <> ''),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  server_version bigint not null check (server_version > 0),
  deleted_at timestamptz,
  server_updated_at timestamptz not null default now(),
  primary key (entity_type, id)
);
create index if not exists pv_entities_folder_ref
  on prompt_vault.entities ((data ->> 'folderId'))
  where entity_type = 'prompt' and deleted_at is null;
create index if not exists pv_entities_parent_ref
  on prompt_vault.entities ((data ->> 'parentId'))
  where entity_type = 'folder' and deleted_at is null;

-- One immutable event = one whole atomic push, including folder-delete effects.
create table if not exists prompt_vault.sync_changes (
  cursor bigint not null check (cursor > 0),
  op_id uuid not null,
  device_id text not null,
  changes jsonb not null check (jsonb_typeof(changes) = 'array'),
  committed_at timestamptz not null default now(),
  primary key (cursor),
  unique (op_id)
);
create table if not exists prompt_vault.sync_receipts (
  op_id uuid not null,
  request_hash bytea not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (op_id)
);

-- All direct client table access is denied, including SELECT. RPCs are the only
-- client entry points. API-key possession grants these RPC capabilities; there
-- is deliberately no per-person authentication or tenant RLS.
alter table prompt_vault.sync_state enable row level security;
alter table prompt_vault.entities enable row level security;
alter table prompt_vault.sync_changes enable row level security;
alter table prompt_vault.sync_receipts enable row level security;
revoke all on all tables in schema prompt_vault from public, anon, authenticated;

create or replace function prompt_vault.parse_version(value text)
returns bigint language plpgsql immutable set search_path = '' as $$
begin
  if value is null or value !~ '^(0|[1-9][0-9]{0,18})$' then
    raise exception using errcode = '22023', message = 'Version/cursor must be a nonnegative decimal string';
  end if;
  return value::bigint;
end $$;

create or replace function prompt_vault.entity_json(e prompt_vault.entities)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'entityType', e.entity_type, 'id', e.id, 'data', e.data,
    'serverVersion', e.server_version::text,
    'deletedAt', (extract(epoch from e.deleted_at) * 1000)::bigint,
    'serverUpdatedAt', e.server_updated_at
  );
$$;

-- Complete replacement bodies (not partial patches). Reject unknown fields so
-- local counters, credentials or client-side version clocks cannot leak in.
create or replace function prompt_vault.validate_body(kind text, body jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare k text; allowed text[]; value jsonb;
begin
  if jsonb_typeof(body) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'data must be an object';
  end if;
  allowed := case kind
    when 'prompt' then array['title','content','description','folderId','tags','favorite','sortOrder','createdAt']
    when 'folder' then array['name','parentId','sortOrder','createdAt'] end;
  if allowed is null or not (body ?& allowed)
    or exists (select 1 from jsonb_object_keys(body) as keys(key) where not (key = any(allowed))) then
    raise exception using errcode = '22023', message = 'Unknown or missing data fields';
  end if;
  foreach k in array case kind when 'prompt' then array['title','content','description'] else array['name'] end loop
    if jsonb_typeof(body -> k) is distinct from 'string' or char_length(body ->> k) > 2000000
      or (k <> 'description' and btrim(body ->> k) = '') then
      raise exception using errcode = '22023', message = 'Invalid text field';
    end if;
  end loop;
  foreach k in array array['sortOrder','createdAt'] loop
    if jsonb_typeof(body -> k) is distinct from 'number' then
      raise exception using errcode = '22023', message = 'Invalid numeric field';
    end if;
    if (body ->> k)::numeric < 0 or (body ->> k)::numeric > 9007199254740991 then
      raise exception using errcode = '22023', message = 'Numeric field out of range';
    end if;
  end loop;
  if trunc((body ->> 'createdAt')::numeric) <> (body ->> 'createdAt')::numeric then
    raise exception using errcode = '22023', message = 'createdAt must be integer milliseconds';
  end if;
  k := case kind when 'prompt' then 'folderId' else 'parentId' end;
  value := body -> k;
  if value <> 'null'::jsonb and (jsonb_typeof(value) <> 'string'
    or octet_length(body ->> k) not between 1 and 512 or btrim(body ->> k) = '') then
    raise exception using errcode = '22023', message = 'Invalid folder reference';
  end if;
  if kind = 'prompt' then
    if jsonb_typeof(body -> 'favorite') is distinct from 'boolean'
      or jsonb_typeof(body -> 'tags') is distinct from 'array' then
      raise exception using errcode = '22023', message = 'Invalid favorite/tags';
    end if;
    if jsonb_array_length(body -> 'tags') > 1000 or exists (
      select 1 from jsonb_array_elements(body -> 'tags') as tags(tag)
      where jsonb_typeof(tag) <> 'string' or char_length(tag #>> '{}') > 2000000
    ) then
      raise exception using errcode = '22023', message = 'Invalid tags';
    end if;
  end if;
end $$;

create or replace function public.pv_sync_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare head bigint;
begin
  select cursor into head from prompt_vault.sync_state where singleton;
  return jsonb_build_object('protocolVersion', 1, 'schemaVersion', 3, 'deploymentMode', 'personal-project-key',
    'cursor', coalesce(head, 0)::text, 'maxChangesPerPush', 500,
    'maxRequestBytes', 16777216, 'maxEventBytes', 16777216);
end $$;

create or replace function public.pv_sync_push(p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  op uuid; dev text; digest bytea; head bigint;
  receipt prompt_vault.sync_receipts; existing prompt_vault.entities;
  item jsonb; kind text; entity_id text; base bigint; tombstone boolean;
  conflicts jsonb := '[]'; result jsonb; rows_json jsonb; stamp timestamptz := clock_timestamp();
begin
  if p_request is null or jsonb_typeof(p_request) <> 'object'
    or octet_length(p_request::text) > 16777216 then
    raise exception using errcode = '22023', message = 'Invalid request or request exceeds 16 MiB';
  end if;
  if p_request -> 'protocolVersion' is distinct from '1'::jsonb
    or not (p_request ?& array['protocolVersion','opId','deviceId','changes'])
    or exists (select 1 from jsonb_object_keys(p_request) as keys(key)
      where key not in ('protocolVersion','opId','deviceId','changes'))
    or jsonb_typeof(p_request -> 'opId') is distinct from 'string'
    or jsonb_typeof(p_request -> 'deviceId') is distinct from 'string'
    or jsonb_typeof(p_request -> 'changes') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Invalid protocol/request fields';
  end if;
  op := (p_request ->> 'opId')::uuid; dev := p_request ->> 'deviceId';
  if octet_length(dev) not between 1 and 128 or btrim(dev) = ''
    or jsonb_array_length(p_request -> 'changes') not between 1 and 500 then
    raise exception using errcode = '22023', message = 'Invalid deviceId or change count (1..500)';
  end if;
  digest := sha256(convert_to(p_request::text, 'UTF8'));
  select cursor into head from prompt_vault.sync_state where singleton for update;
  select * into receipt from prompt_vault.sync_receipts where op_id = op;
  if found then
    if receipt.request_hash <> digest then
      raise exception using errcode = '22023', message = 'opId reused with a different payload';
    end if;
    return receipt.response;
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_request -> 'changes') as items(change)
    group by change ->> 'entityType', change ->> 'id' having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'Duplicate entity in atomic push';
  end if;

  -- Validate every expected version before changing any entity.
  for item in select value from jsonb_array_elements(p_request -> 'changes') loop
    if jsonb_typeof(item) <> 'object' then
      raise exception using errcode = '22023', message = 'Each change must be an object';
    end if;
    if not (item ?& array['entityType','id','baseVersion','deleted','data'])
      or exists (select 1 from jsonb_object_keys(item) as keys(key)
        where key not in ('entityType','id','baseVersion','deleted','data'))
      or jsonb_typeof(item -> 'entityType') is distinct from 'string'
      or jsonb_typeof(item -> 'id') is distinct from 'string'
      or jsonb_typeof(item -> 'baseVersion') is distinct from 'string'
      or jsonb_typeof(item -> 'deleted') is distinct from 'boolean' then
      raise exception using errcode = '22023', message = 'Invalid change fields';
    end if;
    kind := item ->> 'entityType'; entity_id := item ->> 'id';
    base := prompt_vault.parse_version(item ->> 'baseVersion'); tombstone := (item ->> 'deleted')::boolean;
    if kind not in ('prompt','folder') or octet_length(entity_id) not between 1 and 512 or btrim(entity_id) = '' then
      raise exception using errcode = '22023', message = 'Invalid entity type/id';
    end if;
    if tombstone then
      if item -> 'data' <> 'null'::jsonb then
        raise exception using errcode = '22023', message = 'Deletion data must be null';
      end if;
    else
      perform prompt_vault.validate_body(kind, item -> 'data');
    end if;
    select * into existing from prompt_vault.entities
      where entity_type = kind and id = entity_id;
    if (not found and (base <> 0 or tombstone))
      or (found and (existing.server_version <> base or existing.deleted_at is not null)) then
      conflicts := conflicts || jsonb_build_array(jsonb_build_object(
        'entityType', kind, 'id', entity_id, 'current',
        case when existing.id is null then null else prompt_vault.entity_json(existing) end));
    end if;
  end loop;
  if jsonb_array_length(conflicts) > 0 then
    result := jsonb_build_object('status','conflict','opId',op,'conflicts',conflicts);
    if octet_length(result::text) > 16777216 then
      raise exception using errcode = '22023', message = 'Conflict response exceeds 16 MiB; reduce batch';
    end if;
    insert into prompt_vault.sync_receipts values (op,digest,result,stamp);
    return result;
  end if;

  head := head + 1;
  for item in select value from jsonb_array_elements(p_request -> 'changes') loop
    kind := item ->> 'entityType'; entity_id := item ->> 'id';
    if (item ->> 'deleted')::boolean then
      update prompt_vault.entities set deleted_at = stamp, server_version = head, server_updated_at = stamp
        where entity_type = kind and id = entity_id;
    else
      insert into prompt_vault.entities(entity_type,id,data,server_version,server_updated_at)
        values(kind,entity_id,item -> 'data',head,stamp)
        on conflict (entity_type,id) do update
          set data = excluded.data, server_version = excluded.server_version, server_updated_at = excluded.server_updated_at;
    end if;
  end loop;

  -- Match local folder deletion: retain prompts/child folders, remove membership.
  -- Use current server rows to preserve concurrent content edits, and include all
  -- side effects in the SAME event. An explicitly supplied dangling ref fails.
  update prompt_vault.entities e set data = jsonb_set(e.data,'{folderId}','null'),
    server_version = head, server_updated_at = stamp
    where e.entity_type = 'prompt' and e.deleted_at is null
      and e.server_version <> head and exists (
        select 1 from prompt_vault.entities f where f.entity_type = 'folder'
          and f.id = e.data ->> 'folderId' and f.deleted_at is not null and f.server_version = head);
  update prompt_vault.entities e set data = jsonb_set(e.data,'{parentId}','null'),
    server_version = head, server_updated_at = stamp
    where e.entity_type = 'folder' and e.deleted_at is null
      and e.server_version <> head and exists (
        select 1 from prompt_vault.entities f where f.entity_type = 'folder'
          and f.id = e.data ->> 'parentId' and f.deleted_at is not null and f.server_version = head);
  if exists (
    select 1 from prompt_vault.entities e where e.deleted_at is null
      and (e.data ->> case e.entity_type when 'prompt' then 'folderId' else 'parentId' end) is not null
      and not exists (select 1 from prompt_vault.entities f where f.entity_type = 'folder'
        and f.deleted_at is null and f.id = e.data ->> case e.entity_type when 'prompt' then 'folderId' else 'parentId' end)
  ) then
    raise exception using errcode = '22023', message = 'Folder reference is missing or deleted';
  end if;
  -- Every node in a finite, single-parent acyclic graph is reachable from a root.
  if (with recursive reachable(id) as (
    select id from prompt_vault.entities where entity_type = 'folder'
      and deleted_at is null and data ->> 'parentId' is null
    union all
    select f.id from prompt_vault.entities f join reachable r on f.data ->> 'parentId' = r.id
      where f.entity_type = 'folder' and f.deleted_at is null
  ) select count(*) from reachable) <> (
    select count(*) from prompt_vault.entities where entity_type = 'folder' and deleted_at is null
  ) then
    raise exception using errcode = '22023', message = 'Folder parent cycle';
  end if;
  select jsonb_agg(prompt_vault.entity_json(e) order by e.entity_type,e.id) into rows_json
    from prompt_vault.entities e where server_version = head;
  if octet_length(rows_json::text) > 16777216 then
    raise exception using errcode = '22023', message = 'Atomic event exceeds 16 MiB; split independent changes first';
  end if;
  update prompt_vault.sync_state set cursor = head where singleton;
  insert into prompt_vault.sync_changes values (head,op,dev,rows_json,stamp);
  -- ACK deliberately contains no data payload; consume canonical rows via pull.
  result := jsonb_build_object('status','applied','opId',op,'cursor',head::text,
    'versions',(select jsonb_agg(jsonb_build_object('entityType', x -> 'entityType',
      'id', x -> 'id','serverVersion',head::text)) from jsonb_array_elements(rows_json) x));
  insert into prompt_vault.sync_receipts values (op,digest,result,stamp);
  return result;
end $$;

create or replace function public.pv_sync_pull(p_cursor text default '0', p_limit integer default 20, p_until text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  after_cursor bigint; head bigint; until_cursor bigint;
  next_cursor bigint; events jsonb := '[]'; event jsonb; row record; used_bytes bigint := 0;
begin
  after_cursor := prompt_vault.parse_version(p_cursor);
  if p_limit is null or p_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'p_limit must be 1..50';
  end if;
  select cursor into head from prompt_vault.sync_state where singleton;
  head := coalesce(head,0);
  until_cursor := case when p_until is null then head else prompt_vault.parse_version(p_until) end;
  if after_cursor > until_cursor or until_cursor > head then
    raise exception using errcode = '22023', message = 'Cursor is ahead of vault history';
  end if;
  next_cursor := after_cursor;
  for row in select * from prompt_vault.sync_changes where cursor > after_cursor and cursor <= until_cursor order by cursor limit p_limit loop
    event := jsonb_build_object('cursor',row.cursor::text,'opId',row.op_id,
      'deviceId',row.device_id,'changes',row.changes);
    if used_bytes + octet_length(event::text) > 20971520 and jsonb_array_length(events) > 0 then exit; end if;
    events := events || jsonb_build_array(event);
    used_bytes := used_bytes + octet_length(event::text);
    next_cursor := row.cursor;
  end loop;
  return jsonb_build_object('protocolVersion',1,'events',events,'nextCursor',next_cursor::text,
    'highWater',until_cursor::text,'hasMore',next_cursor < until_cursor);
end $$;

-- Helpers must never be callable by clients. No project-wide default privilege
-- changes and no broad grants on public.* (other applications may coexist).
revoke all on all functions in schema prompt_vault from public, anon, authenticated;
revoke all on function public.pv_sync_status() from public, anon, authenticated;
revoke all on function public.pv_sync_push(jsonb) from public, anon, authenticated;
revoke all on function public.pv_sync_pull(text,integer,text) from public, anon, authenticated;
grant execute on function public.pv_sync_status(), public.pv_sync_push(jsonb),
  public.pv_sync_pull(text,integer,text) to anon;
notify pgrst, 'reload schema';
commit;
