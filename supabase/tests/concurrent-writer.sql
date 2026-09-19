-- Invoked only by the isolated test runner, with synthetic psql variables.
begin;
set local role anon;
select public.pv_sync_push(jsonb_build_object(
  'protocolVersion',1,'opId',:'op_id','deviceId','parallel-test',
  'changes',jsonb_build_array(jsonb_build_object(
    'entityType','folder','id',:'entity_id','baseVersion','0','deleted',false,
    'data',jsonb_build_object('name',:'entity_id','parentId',null,'sortOrder',10,'createdAt',1000)
  ))
));
select 'LOCK_HELD';
select pg_sleep(:hold_seconds);
commit;
