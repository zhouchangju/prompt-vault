-- LOCAL TEST CLUSTER ONLY. No Auth schema/users/functions: prove no dependency.
create role anon nologin;
create role authenticated nologin;
create role rpc_ungranted nologin;
