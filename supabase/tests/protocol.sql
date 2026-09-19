-- LOCAL TEST CLUSTER ONLY: synthetic records remain for rerun tests.
do $$ begin
  if current_setting('prompt_vault.test_environment', true) is distinct from 'isolated-local' then
    raise exception 'Use scripts/test-supabase.sh; do not execute this test on Supabase';
  end if;
end $$;
create function pg_temp.assert_true(ok boolean, label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'FAIL: %', label; end if; end $$;
create function pg_temp.expect_error(statement text, expected_state text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if sqlstate = expected_state then return; end if;
    raise exception 'Wrong error state: % expected %, message %', sqlstate, expected_state, sqlerrm;
  end;
  raise exception 'Expected error %, statement succeeded', expected_state;
end $$;
create function pg_temp.folder(name text, parent text default null) returns jsonb language sql as $$
  select jsonb_build_object('name',name,'parentId',parent,'sortOrder',0,'createdAt',1000);
$$;
create function pg_temp.prompt(title text, folder text default null) returns jsonb language sql as $$
  select jsonb_build_object('title',title,'content','Synthetic {{name}}','description','',
    'folderId',folder,'tags',jsonb_build_array('test'),'favorite',false,'sortOrder',0,'createdAt',1000);
$$;
create function pg_temp.change(kind text, id text, version text, data jsonb, deleted boolean default false)
returns jsonb language sql as $$
  select jsonb_build_object('entityType',kind,'id',id,'baseVersion',version,'deleted',deleted,'data',data);
$$;
create function pg_temp.request(id integer, changes jsonb) returns jsonb language sql as $$
  select jsonb_build_object('protocolVersion',1,'opId','10000000-0000-0000-0000-' || lpad(id::text,12,'0'),
    'deviceId','synthetic-device','changes',changes);
$$;

-- Temporary privileged inspectors belong only to this local test session.
create function pg_temp.read_entities() returns setof prompt_vault.entities
language sql security definer set search_path = '' as $$ select * from prompt_vault.entities $$;
create function pg_temp.change_count() returns bigint
language sql security definer set search_path = '' as $$ select count(*) from prompt_vault.sync_changes $$;
create function pg_temp.state_count() returns bigint
language sql security definer set search_path = '' as $$ select count(*) from prompt_vault.sync_state $$;

set role rpc_ungranted;
select pg_temp.expect_error('select public.pv_sync_status()', '42501');
select pg_temp.expect_error('select public.pv_sync_pull()', '42501');
select pg_temp.expect_error('select public.pv_sync_push(null)', '42501');
reset role;
set role anon;
do $$
declare req jsonb; result jsonb; changes jsonb; original jsonb; before_head text;
begin
  perform pg_temp.assert_true(public.pv_sync_status() ->> 'cursor' = '0','empty status');
  perform pg_temp.assert_true(public.pv_sync_pull() -> 'events' = '[]'::jsonb,'empty read');
  perform pg_temp.assert_true(pg_temp.state_count() = 1,'read RPCs preserve singleton state');
  -- Child before parent in the same atomic push is supported.
  changes := jsonb_build_array(pg_temp.change('prompt','prompt-1','0',pg_temp.prompt('One','folder-1')),
    pg_temp.change('folder','folder-1','0',pg_temp.folder('Work')),
    pg_temp.change('folder','child','0',pg_temp.folder('Child','folder-1')));
  req := pg_temp.request(1,changes);
  result := public.pv_sync_push(req);
  perform pg_temp.assert_true(result ->> 'status' = 'applied' and result ->> 'cursor' = '1','create atomic group');
  perform pg_temp.assert_true(public.pv_sync_push(req) = result,'ACK lost replay identical');
  perform pg_temp.assert_true(pg_temp.change_count() = 1,'replay no duplicate event');
  perform pg_temp.expect_error(format('select public.pv_sync_push(%L::jsonb)',jsonb_set(req,'{deviceId}','"other"')), '22023');
  original := public.pv_sync_pull('0',1);
  perform pg_temp.assert_true(jsonb_array_length(original -> 'events' -> 0 -> 'changes') = 3,'page never splits transaction');
  perform pg_temp.expect_error('insert into prompt_vault.entities select * from prompt_vault.entities', '42501');
  perform pg_temp.expect_error('delete from prompt_vault.sync_changes', '42501');
  perform pg_temp.expect_error('select prompt_vault.parse_version(''0'')', '42501');

  -- A stale operation prevents ALL writes in its atomic group.
  req := pg_temp.request(2,jsonb_build_array(pg_temp.change('prompt','prompt-1','0',pg_temp.prompt('Stale','folder-1')),
    pg_temp.change('prompt','must-not-exist','0',pg_temp.prompt('Unrelated'))));
  result := public.pv_sync_push(req);
  perform pg_temp.assert_true(result ->> 'status' = 'conflict','stale base rejected');
  perform pg_temp.assert_true(not exists(select 1 from pg_temp.read_entities() where id='must-not-exist'),'conflict group atomic');
  perform pg_temp.assert_true(public.pv_sync_push(req) = result,'conflict receipt replay');
  perform pg_temp.assert_true(public.pv_sync_status() ->> 'cursor' = '1','conflict no cursor advancement');

  req := pg_temp.request(3,jsonb_build_array(pg_temp.change('prompt','prompt-1','1',pg_temp.prompt('Edited','folder-1'))));
  perform public.pv_sync_push(req);
  perform pg_temp.assert_true(public.pv_sync_status() ->> 'cursor' = '2','new valid version');
  perform pg_temp.assert_true((public.pv_sync_pull('0',1,'1') ->> 'highWater') = '1','fixed water retained');
  perform pg_temp.assert_true((public.pv_sync_pull('1',1,'1') -> 'events') = '[]'::jsonb,'fixed water excludes later commits');
  perform pg_temp.assert_true((public.pv_sync_pull('0',1) ->> 'hasMore')::boolean,'pagination continuation');
  perform pg_temp.assert_true(public.pv_sync_pull('1',1) ->> 'nextCursor' = '2','incremental next event');

  -- Delete folder: preserve edited prompt body, ungroup prompt and child folder.
  perform public.pv_sync_push(pg_temp.request(4,jsonb_build_array(pg_temp.change('folder','folder-1','1',null,true))));
  result := public.pv_sync_pull('2');
  perform pg_temp.assert_true(jsonb_array_length(result -> 'events' -> 0 -> 'changes') = 3,'delete side effects in same event');
  perform pg_temp.assert_true((select data ->> 'folderId' is null and data ->> 'title' = 'Edited' from pg_temp.read_entities() where id='prompt-1'),'ungroup preserves content');
  perform pg_temp.assert_true((select data ->> 'parentId' is null from pg_temp.read_entities() where id='child'),'child folder survives');
  result := public.pv_sync_push(pg_temp.request(5,jsonb_build_array(pg_temp.change('folder','folder-1','3',pg_temp.folder('Revive')))));
  perform pg_temp.assert_true(result ->> 'status' = 'conflict','tombstone cannot be resurrected');
  perform pg_temp.expect_error(format('select public.pv_sync_push(%L::jsonb)',pg_temp.request(6,jsonb_build_array(
    pg_temp.change('prompt','dangling','0',pg_temp.prompt('Bad','folder-1'))))), '22023');
  perform pg_temp.assert_true(public.pv_sync_status() ->> 'cursor' = '3','invalid reference rolls back cursor');
  perform pg_temp.assert_true(not exists(select 1 from pg_temp.read_entities() where id='dangling'),'invalid reference rolls back row');

  perform pg_temp.expect_error(format('select public.pv_sync_push(%L::jsonb)',pg_temp.request(7,jsonb_build_array(
    pg_temp.change('folder','cycle-a','0',pg_temp.folder('A','cycle-b')),
    pg_temp.change('folder','cycle-b','0',pg_temp.folder('B','cycle-a'))))), '22023');
  perform pg_temp.expect_error(format('select public.pv_sync_push(%L::jsonb)',pg_temp.request(8,jsonb_build_array(
    pg_temp.change('prompt','bad','0',pg_temp.prompt('Bad') || '{"useCount":2}'::jsonb)))), '22023');
  perform pg_temp.expect_error(format('select public.pv_sync_push(%L::jsonb)',pg_temp.request(9,jsonb_build_array(
    pg_temp.change('prompt','bad','0',jsonb_set(pg_temp.prompt('Bad'),'{favorite}','"true"'))))), '22023');
  perform pg_temp.expect_error(format('select public.pv_sync_push(%L::jsonb)',pg_temp.request(10,jsonb_build_array(
    pg_temp.change('prompt','dup','0',pg_temp.prompt('A')),pg_temp.change('prompt','dup','0',pg_temp.prompt('B'))))), '22023');
  perform pg_temp.expect_error('select public.pv_sync_pull(''999'')', '22023');
  perform pg_temp.expect_error('select public.pv_sync_pull(''0'',0)', '22023');
  perform pg_temp.expect_error('select public.pv_sync_pull(''-1'')', '22023');
  perform pg_temp.expect_error('select public.pv_sync_push(null)', '22023');
  perform pg_temp.expect_error('select public.pv_sync_push(''{}''::jsonb)', '22023');
  perform pg_temp.expect_error(format('select public.pv_sync_push(%L::jsonb)',pg_temp.request(30,jsonb_build_array(
    pg_temp.change('prompt','bad','0',pg_temp.prompt('Bad')))) || '{"user_id":"00000000-0000-0000-0000-000000000002"}'::jsonb), '22023');
  perform pg_temp.expect_error(format('select public.pv_sync_push(%L::jsonb)',pg_temp.request(31,jsonb_build_array(
    pg_temp.change('prompt',repeat('x',513),'0',pg_temp.prompt('Bad'))))), '22023');
  perform pg_temp.expect_error(format('select public.pv_sync_push(%L::jsonb)',pg_temp.request(32,jsonb_build_array(
    pg_temp.change('prompt','bad','0',jsonb_set(pg_temp.prompt('Bad'),'{sortOrder}','-1'))))), '22023');
  perform pg_temp.expect_error(format('select public.pv_sync_push(%L::jsonb)',pg_temp.request(33,(
    select jsonb_agg(pg_temp.change('folder','bulk-' || i,'0',pg_temp.folder('Bulk'))) from generate_series(1,501) i))), '22023');
  perform pg_temp.expect_error(format('select public.pv_sync_push(%L::jsonb)',pg_temp.request(34,jsonb_build_array(
    pg_temp.change('prompt','bad','0',jsonb_set(pg_temp.prompt('Bad'),'{content}',to_jsonb(repeat('x',2000001))))))), '22023');

  -- Prompt delete creates a durable tombstone and is replayable from cursor 0.
  perform public.pv_sync_push(pg_temp.request(11,jsonb_build_array(pg_temp.change('prompt','prompt-1','3',null,true))));
  perform pg_temp.assert_true(public.pv_sync_status() ->> 'cursor' = '4','prompt delete cursor');
  perform pg_temp.assert_true((select deleted_at is not null from pg_temp.read_entities() where id='prompt-1'),'prompt tombstone');
end $$;

-- All direct table access is denied, including for the intended anon API role.
select pg_temp.expect_error('select * from prompt_vault.entities', '42501');
select pg_temp.expect_error('update prompt_vault.sync_state set cursor = 999', '42501');
reset role;
set role authenticated;
select pg_temp.expect_error('select public.pv_sync_status()', '42501');
select pg_temp.expect_error('select public.pv_sync_pull()', '42501');
select pg_temp.expect_error('select public.pv_sync_push(null)', '42501');
reset role;
do $$ begin
  perform pg_temp.assert_true((select count(*) from prompt_vault.sync_state) = 1,'one vault only');
  perform pg_temp.assert_true(to_regnamespace('auth') is null,'no Auth dependency');
end $$;
select 'PASS: anon RPC only, no Auth dependency, idempotency, atomicity, CAS, references, deletion, pagination' as result;
