-- Retail Innovation Challenge: event state lives in a private schema that the API cannot reach directly.
-- After applying, store the SHA-256 (hex) of your server key:
--   insert into ric.server_key (key_sha256) values ('<sha256 hex of RIC_SERVER_KEY>');
create schema if not exists ric;
revoke all on schema ric from public, anon, authenticated;

create table ric.events (
  id text primary key,
  state jsonb not null,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);
create table ric.server_key (id int primary key default 1 check (id = 1), key_sha256 text not null);
alter table ric.events enable row level security;
alter table ric.server_key enable row level security;

create or replace function ric.check_key(p_key text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from ric.server_key where key_sha256 = encode(extensions.digest(p_key, 'sha256'), 'hex')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end $$;

create or replace function public.ric_get(p_key text, p_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  perform ric.check_key(p_key);
  select jsonb_build_object('state', state, 'version', version) into r from ric.events where id = p_id;
  return r;
end $$;

create or replace function public.ric_version(p_key text, p_id text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v bigint;
begin
  perform ric.check_key(p_key);
  select version into v from ric.events where id = p_id;
  return v;
end $$;

create or replace function public.ric_init(p_key text, p_id text, p_state jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform ric.check_key(p_key);
  insert into ric.events (id, state) values (p_id, p_state) on conflict (id) do nothing;
  return (select jsonb_build_object('state', state, 'version', version) from ric.events where id = p_id);
end $$;

create or replace function public.ric_cas(p_key text, p_id text, p_version bigint, p_state jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v bigint;
begin
  perform ric.check_key(p_key);
  update ric.events set state = p_state, version = version + 1, updated_at = now()
   where id = p_id and version = p_version returning version into v;
  return v;
end $$;

revoke all on function ric.check_key(text) from public, anon, authenticated;
revoke all on function public.ric_get(text, text), public.ric_version(text, text), public.ric_init(text, text, jsonb), public.ric_cas(text, text, bigint, jsonb) from public, authenticated;
grant execute on function public.ric_get(text, text), public.ric_version(text, text), public.ric_init(text, text, jsonb), public.ric_cas(text, text, bigint, jsonb) to anon;
