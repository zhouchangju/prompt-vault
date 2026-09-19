#!/usr/bin/env bash
# Isolated Unix-socket-only PostgreSQL. Never connects to an existing database.
set -euo pipefail
cd "$(dirname "$0")/.."
for binary in initdb pg_ctl psql; do command -v "$binary" >/dev/null || { echo "Missing $binary" >&2; exit 1; }; done
scratch=$(mktemp -d /tmp/prompt-vault-sql.XXXXXX)
cleanup() {
  pg_ctl -D "$scratch/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT
initdb -D "$scratch/data" -U postgres -A trust --no-locale -E UTF8 >"$scratch/init.log" 2>&1
pg_ctl -D "$scratch/data" -l "$scratch/server.log" -o "-k $scratch -h ''" -w start >/dev/null
psql_local() {
  env -u PGSERVICE -u PGOPTIONS psql -X -h "$scratch" -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"
}
psql_local -q -f supabase/tests/bootstrap.sql
psql_local -q -f supabase/setup.sql
psql_local -q -c "set prompt_vault.test_environment = 'isolated-local'" -f supabase/tests/protocol.sql
psql_local -q -f supabase/setup.sql
psql_local -q -c "do \$\$ begin if (select cursor from prompt_vault.sync_state where singleton) <> 4 then raise exception 'rerun lost data'; end if; end \$\$;"
# Two independent connections: B must not allocate/commit cursor 6 while A's
# cursor 5 is still uncommitted. Read during A must see a complete old waterline.
psql_local -At -v op_id=10000000-0000-0000-0000-000000000101 -v entity_id=parallel-a \
  -v hold_seconds=2 -f supabase/tests/concurrent-writer.sql >"$scratch/writer-a.log" 2>&1 &
writer_a=$!
ready=0
for ((i=0; i<100; i++)); do
  if [[ $(< "$scratch/writer-a.log") == *LOCK_HELD* ]]; then ready=1; break; fi
  sleep 0.05
done
if [[ "$ready" != 1 ]]; then cat "$scratch/writer-a.log"; exit 1; fi
psql_local -At -v op_id=10000000-0000-0000-0000-000000000102 -v entity_id=parallel-b \
  -v hold_seconds=0 -f supabase/tests/concurrent-writer.sql >"$scratch/writer-b.log" 2>&1 &
writer_b=$!
psql_local -q -c "set role anon; do \$\$ begin if public.pv_sync_pull('4')->>'highWater' <> '4' then raise exception 'uncommitted waterline escaped'; end if; end \$\$;"
wait "$writer_a" || { cat "$scratch/writer-a.log"; exit 1; }
wait "$writer_b" || { cat "$scratch/writer-b.log"; exit 1; }
psql_local -q -c "set role anon; do \$\$ declare r jsonb := public.pv_sync_pull('4'); begin if r->>'nextCursor' <> '6' or r->'events'->0->>'cursor' <> '5' or r->'events'->1->>'cursor' <> '6' then raise exception 'concurrent history missing or out of order'; end if; end \$\$;"
# Legacy marker causes a safe refusal, without altering existing vault data.
psql_local -q -c "create table prompt_vault.schema_info (version integer); insert into prompt_vault.schema_info values (1);"
if psql_local -q -f supabase/setup.sql >"$scratch/legacy.log" 2>&1; then echo 'FAIL: accepted legacy schema'; exit 1; fi
psql_local -q -c "do \$\$ begin if (select cursor from prompt_vault.sync_state) <> 6 then raise exception 'legacy check lost data'; end if; end \$\$; drop table prompt_vault.schema_info;"
psql_local -f supabase/verify.sql
PROMPT_VAULT_TEST_SOCKET="$scratch" node --test tests/sync-sql.integration.mjs
echo 'PASS: SQL protocol tests, installer rerun preserves data, concurrent commit ordering, installation verification'
