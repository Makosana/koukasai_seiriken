-- 紅華祭 整理券アプリ Supabase版 DB定義 v1
-- Supabase の SQL Editor に全文を貼り付けて実行します（1回だけ）。
-- ルールは Wi-Fi版（source/backend/lib/seiriken-service.mjs）と同じです。
-- 来場者もスタッフも表を直接読めません。読み書きはすべて下の関数経由です。

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------- 表 ----------

create table public.settings (
  key text primary key,
  value text not null
);
insert into public.settings(key, value)
values ('event_date', to_char(now() at time zone 'Asia/Tokyo', 'YYYY-MM-DD'))
on conflict (key) do nothing;

create table public.rounds (
  id bigint generated always as identity primary key,
  label text not null check (char_length(label) between 1 and 40),
  starts_time text not null check (starts_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  opens_time text not null check (opens_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  closes_time text not null check (closes_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  capacity_people integer not null check (capacity_people between 1 and 10000),
  max_party integer not null default 4 check (max_party between 1 and 20),
  finish_after_minutes integer not null default 30 check (finish_after_minutes between 0 and 600),
  paused boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (opens_time < closes_time)
);

create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  round_id bigint not null references public.rounds(id),
  number integer not null check (number >= 1),
  party_size integer not null check (party_size between 1 and 20),
  device_id uuid not null,
  request_id uuid not null unique,
  cancel_token text not null,
  status text not null default 'active' check (status in ('active', 'cancelled')),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by text check (cancelled_by in ('visitor', 'staff')),
  unique (round_id, number)
);
-- 1つの端末が同じ回で有効な整理券を2枚持てないようにする
create unique index tickets_one_active_per_device on public.tickets(round_id, device_id) where status = 'active';
create index tickets_by_round on public.tickets(round_id, status);

create table public.operations (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  actor uuid,
  action text not null,
  details jsonb not null
);

alter table public.settings enable row level security;
alter table public.rounds enable row level security;
alter table public.tickets enable row level security;
alter table public.operations enable row level security;
revoke all on public.settings, public.rounds, public.tickets, public.operations from anon, authenticated;

-- ---------- 記録を守るトリガー ----------

create or replace function private.tickets_cancel_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception '整理券の記録は削除できません。';
  end if;
  if old.status <> 'active' or new.status <> 'cancelled'
     or new.id <> old.id or new.round_id <> old.round_id or new.number <> old.number
     or new.party_size <> old.party_size or new.device_id <> old.device_id
     or new.request_id <> old.request_id or new.cancel_token <> old.cancel_token
     or new.created_at <> old.created_at
     or new.cancelled_at is null or new.cancelled_by is null then
    raise exception '整理券は取消以外の変更ができません。';
  end if;
  return new;
end $$;
create trigger tickets_cancel_only before update or delete on public.tickets
for each row execute function private.tickets_cancel_only();

create or replace function private.rounds_keep_issued() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.tickets where round_id = old.id) then
    raise exception '整理券を発行した回は削除できません。';
  end if;
  return old;
end $$;
create trigger rounds_keep_issued before delete on public.rounds
for each row execute function private.rounds_keep_issued();

create or replace function private.operations_locked() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '操作記録は変更・削除できません。';
end $$;
create trigger operations_locked before update or delete on public.operations
for each row execute function private.operations_locked();

-- ---------- 内部用の関数（APIには公開しない） ----------

-- 画面側では hint を「エラーコード」として扱う
create or replace function private.fail(p_message text, p_code text) returns void
language plpgsql set search_path = '' as $$
begin
  raise exception using message = p_message, hint = p_code;
end $$;

create or replace function private.iso(p timestamptz) returns text
language sql immutable set search_path = '' as $$
  select to_char(p at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

create or replace function private.at(p_date text, p_time text) returns timestamptz
language sql stable set search_path = '' as $$
  select (p_date || ' ' || p_time)::timestamp at time zone 'Asia/Tokyo'
$$;

create or replace function private.event_date() returns text
language sql stable set search_path = '' as $$
  select value from public.settings where key = 'event_date'
$$;

create or replace function private.round_json(r public.rounds, p_admin boolean) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  d text := private.event_date();
  v_now timestamptz := now();
  s timestamptz := private.at(d, r.starts_time);
  o timestamptz := private.at(d, r.opens_time);
  c timestamptz := private.at(d, r.closes_time);
  f timestamptz := private.at(d, r.starts_time) + make_interval(mins => r.finish_after_minutes);
  used integer; active_n integer; cancelled_n integer; cancelled_p integer; last_n integer;
  remaining integer; st text; result jsonb;
begin
  select coalesce(sum(t.party_size) filter (where t.status = 'active'), 0),
         count(*) filter (where t.status = 'active'),
         count(*) filter (where t.status = 'cancelled'),
         coalesce(sum(t.party_size) filter (where t.status = 'cancelled'), 0),
         coalesce(max(t.number), 0)
    into used, active_n, cancelled_n, cancelled_p, last_n
    from public.tickets t where t.round_id = r.id;
  remaining := greatest(0, r.capacity_people - used);
  st := case
    when v_now >= f then 'finished'
    when v_now >= c then 'closed'
    when v_now < o then 'before'
    when r.paused then 'paused'
    when remaining < 1 then 'full'
    else 'open' end;
  result := jsonb_build_object(
    'id', r.id, 'label', r.label,
    'starts_time', r.starts_time, 'opens_time', r.opens_time, 'closes_time', r.closes_time,
    'starts_at', private.iso(s), 'opens_at', private.iso(o), 'closes_at', private.iso(c), 'finishes_at', private.iso(f),
    'capacity_people', r.capacity_people, 'max_party', r.max_party, 'remaining', remaining, 'status', st);
  if p_admin then
    result := result || jsonb_build_object(
      'finish_after_minutes', r.finish_after_minutes, 'paused', r.paused, 'used_people', used,
      'active_count', active_n, 'cancelled_count', cancelled_n, 'cancelled_people', cancelled_p, 'last_number', last_n);
  end if;
  return result;
end $$;

create or replace function private.ticket_json(t public.tickets, p_with_token boolean, p_admin boolean) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  r public.rounds;
  d text := private.event_date();
  s timestamptz; f timestamptz; result jsonb;
begin
  select * into r from public.rounds where id = t.round_id;
  s := private.at(d, r.starts_time);
  f := s + make_interval(mins => r.finish_after_minutes);
  result := jsonb_build_object(
    'id', t.id, 'round_id', t.round_id, 'round_label', r.label, 'starts_time', r.starts_time, 'starts_at', private.iso(s),
    'number', t.number, 'party_size', t.party_size, 'status', t.status,
    'created_at', private.iso(t.created_at), 'cancelled_at', case when t.cancelled_at is null then null else private.iso(t.cancelled_at) end,
    'cancelled_by', t.cancelled_by,
    'cancellable', t.status = 'active' and now() < s,
    'round_finished', now() >= f);
  if p_with_token then result := result || jsonb_build_object('token', t.cancel_token); end if;
  if p_admin then result := result || jsonb_build_object('device', left(t.device_id::text, 8)); end if;
  return result;
end $$;

create or replace function private.require_staff() returns void
language plpgsql stable set search_path = '' as $$
begin
  if auth.uid() is null then
    perform private.fail('運営画面を使うにはログインしてください。', 'login');
  end if;
end $$;

create or replace function private.int_arg(p jsonb, p_key text, p_min integer, p_max integer, p_label text) returns integer
language plpgsql immutable set search_path = '' as $$
declare v numeric;
begin
  if jsonb_typeof(p -> p_key) <> 'number' then
    perform private.fail(format('%sは%s〜%sの整数で入力してください。', p_label, p_min, p_max), 'invalid');
  end if;
  v := (p ->> p_key)::numeric;
  if v <> trunc(v) or v < p_min or v > p_max then
    perform private.fail(format('%sは%s〜%sの整数で入力してください。', p_label, p_min, p_max), 'invalid');
  end if;
  return v::integer;
end $$;

create or replace function private.time_arg(p jsonb, p_key text, p_label text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if coalesce(p ->> p_key, '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    perform private.fail(format('%sを「10:00」の形式で入力してください。', p_label), 'invalid');
  end if;
  return p ->> p_key;
end $$;

create or replace function private.record(p_action text, p_details jsonb) returns void
language sql set search_path = '' as $$
  insert into public.operations(actor, action, details) values (auth.uid(), p_action, p_details)
$$;

-- ---------- 来場者向けの関数 ----------

create or replace function public.public_state() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'now', private.iso(now()),
    'eventDate', private.event_date(),
    'rounds', coalesce((select jsonb_agg(private.round_json(r, false) order by r.starts_time, r.id) from public.rounds r), '[]'::jsonb))
$$;

create or replace function public.issue_ticket(p_round_id bigint, p_party_size integer, p_device_id uuid, p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.rounds; v jsonb; st text; remaining integer;
  existing public.tickets; created public.tickets; next_number integer;
begin
  if p_party_size is null or p_party_size < 1 or p_party_size > 20 then
    perform private.fail('人数は1〜20の整数で入力してください。', 'invalid');
  end if;
  -- 回の行をロックし、同じ回への申し込みを1件ずつ処理する
  select * into r from public.rounds where id = p_round_id for update;
  if not found then
    perform private.fail('この回は見つかりません。画面を再読み込みしてください。', 'not_found');
  end if;
  select * into existing from public.tickets where request_id = p_request_id;
  if found then
    if existing.device_id <> p_device_id then
      perform private.fail('送信番号が重複しています。画面を再読み込みしてください。', 'request_conflict');
    end if;
    return jsonb_build_object('ticket', private.ticket_json(existing, true, false), 'replayed', true);
  end if;
  v := private.round_json(r, false);
  st := v ->> 'status';
  remaining := (v ->> 'remaining')::integer;
  if st = 'before' then perform private.fail(format('まだ受付前です。%s から受け付けます。', r.opens_time), 'before'); end if;
  if st = 'paused' then perform private.fail('現在、この回の受付を一時停止しています。しばらくしてからお試しください。', 'paused'); end if;
  if st in ('closed', 'finished') then perform private.fail('この回の受付は終了しました。', 'closed'); end if;
  if st = 'full' then perform private.fail('この回は満員になりました。', 'full'); end if;
  if p_party_size > r.max_party then perform private.fail(format('1枚で入れるのは %s 名までです。', r.max_party), 'party'); end if;
  if p_party_size > remaining then perform private.fail(format('残りは %s 名分です。人数を減らしてください。', remaining), 'remaining'); end if;
  if exists (select 1 from public.tickets where round_id = r.id and device_id = p_device_id and status = 'active') then
    perform private.fail('この回の整理券はすでにお持ちです。「整理券を見る」から確認してください。', 'already');
  end if;
  select coalesce(max(number), 0) + 1 into next_number from public.tickets where round_id = r.id;
  insert into public.tickets(round_id, number, party_size, device_id, request_id, cancel_token)
  values (r.id, next_number, p_party_size, p_device_id, p_request_id,
          replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
  returning * into created;
  return jsonb_build_object('ticket', private.ticket_json(created, true, false), 'replayed', false);
end $$;

create or replace function public.find_request(p_request_id uuid, p_device_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.tickets;
begin
  select * into t from public.tickets where request_id = p_request_id;
  if not found or t.device_id <> p_device_id then
    return jsonb_build_object('ticket', null);
  end if;
  return jsonb_build_object('ticket', private.ticket_json(t, true, false));
end $$;

create or replace function public.lookup_tickets(p_items jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  item jsonb; t public.tickets; list jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 30 then
    perform private.fail('整理券の情報を読み取れません。', 'invalid');
  end if;
  for item in select value from jsonb_array_elements(p_items) loop
    t := null;
    if coalesce(item ->> 'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select * into t from public.tickets where id = (item ->> 'id')::uuid and cancel_token = coalesce(item ->> 'token', '');
    end if;
    list := list || jsonb_build_array(case when t.id is null then null else private.ticket_json(t, true, false) end);
  end loop;
  return jsonb_build_object('now', private.iso(now()), 'tickets', list);
end $$;

create or replace function public.cancel_ticket(p_id uuid, p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.tickets; r public.rounds;
begin
  select * into t from public.tickets where id = p_id for update;
  if not found or t.cancel_token <> coalesce(p_token, '') then
    perform private.fail('整理券を確認できません。', 'forbidden');
  end if;
  if t.status = 'cancelled' then
    return jsonb_build_object('ticket', private.ticket_json(t, true, false), 'replayed', true);
  end if;
  select * into r from public.rounds where id = t.round_id;
  if now() >= private.at(private.event_date(), r.starts_time) then
    perform private.fail('開演時刻を過ぎたため、この整理券は取り消せません。', 'started');
  end if;
  update public.tickets set status = 'cancelled', cancelled_at = now(), cancelled_by = 'visitor'
  where id = p_id returning * into t;
  return jsonb_build_object('ticket', private.ticket_json(t, true, false), 'replayed', false);
end $$;

-- ---------- 運営スタッフ向けの関数（ログインした人だけ） ----------

create or replace function public.admin_state() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare rounds jsonb;
begin
  perform private.require_staff();
  select coalesce(jsonb_agg(private.round_json(r, true) order by r.starts_time, r.id), '[]'::jsonb) into rounds from public.rounds r;
  return jsonb_build_object(
    'now', private.iso(now()),
    'eventDate', private.event_date(),
    'today', to_char(now() at time zone 'Asia/Tokyo', 'YYYY-MM-DD'),
    'rounds', rounds,
    'totals', jsonb_build_object(
      'tickets', coalesce((select sum((x ->> 'active_count')::integer) from jsonb_array_elements(rounds) x), 0),
      'people', coalesce((select sum((x ->> 'used_people')::integer) from jsonb_array_elements(rounds) x), 0),
      'cancelled', coalesce((select sum((x ->> 'cancelled_count')::integer) from jsonb_array_elements(rounds) x), 0),
      'capacity', coalesce((select sum((x ->> 'capacity_people')::integer) from jsonb_array_elements(rounds) x), 0),
      'remaining', coalesce((select sum((x ->> 'remaining')::integer) from jsonb_array_elements(rounds) x), 0)));
end $$;

create or replace function public.admin_operation(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  action text := p ->> 'action';
  v_label text; v_starts text; v_opens text; v_closes text;
  v_capacity integer; v_max integer; v_finish integer;
  v_id bigint; r public.rounds; used integer; issued integer; new_id bigint;
begin
  perform private.require_staff();
  if action = 'settings' then
    if coalesce(p ->> 'eventDate', '') !~ '^\d{4}-\d{2}-\d{2}$' then
      perform private.fail('開催日を正しく入力してください。', 'invalid');
    end if;
    begin
      perform (p ->> 'eventDate')::date;
    exception when others then
      perform private.fail('開催日を正しく入力してください。', 'invalid');
    end;
    update public.settings set value = p ->> 'eventDate' where key = 'event_date';
    perform private.record(action, jsonb_build_object('eventDate', p ->> 'eventDate'));
    return jsonb_build_object('ok', true);
  end if;

  if action in ('create', 'update') then
    v_label := btrim(coalesce(p ->> 'label', ''));
    if char_length(v_label) < 1 or char_length(v_label) > 40 then
      perform private.fail('回の名前は1〜40文字で入力してください。', 'invalid');
    end if;
    v_starts := private.time_arg(p, 'startsTime', '開演時刻');
    v_opens := private.time_arg(p, 'opensTime', '受付開始時刻');
    v_closes := private.time_arg(p, 'closesTime', '受付終了時刻');
    if v_opens >= v_closes then
      perform private.fail('受付終了時刻は受付開始時刻より後にしてください。', 'invalid');
    end if;
    v_capacity := private.int_arg(p, 'capacity', 1, 10000, '定員');
    v_max := private.int_arg(p, 'maxParty', 1, 20, '1枚あたりの最大人数');
    v_finish := private.int_arg(p, 'finishAfterMinutes', 0, 600, '終了扱いまでの時間（分）');
  end if;

  if action = 'create' then
    insert into public.rounds(label, starts_time, opens_time, closes_time, capacity_people, max_party, finish_after_minutes)
    values (v_label, v_starts, v_opens, v_closes, v_capacity, v_max, v_finish) returning id into new_id;
    perform private.record(action, p || jsonb_build_object('id', new_id));
    return jsonb_build_object('ok', true, 'id', new_id);
  end if;

  v_id := private.int_arg(p, 'id', 1, 2147483647, '回');
  select * into r from public.rounds where id = v_id for update;
  if not found then perform private.fail('この回は見つかりません。', 'not_found'); end if;
  select coalesce(sum(party_size) filter (where status = 'active'), 0), count(*)
    into used, issued from public.tickets where round_id = v_id;

  if action = 'update' then
    if v_capacity < used then
      perform private.fail(format('すでに %s 名分を発行しているため、定員をそれより少なくできません。', used), 'invalid');
    end if;
    update public.rounds set label = v_label, starts_time = v_starts, opens_time = v_opens, closes_time = v_closes,
      capacity_people = v_capacity, max_party = v_max, finish_after_minutes = v_finish, updated_at = now()
    where id = v_id;
    perform private.record(action, p);
    return jsonb_build_object('ok', true);
  end if;
  if action in ('pause', 'resume') then
    update public.rounds set paused = (action = 'pause'), updated_at = now() where id = v_id;
    perform private.record(action, jsonb_build_object('id', v_id));
    return jsonb_build_object('ok', true);
  end if;
  if action = 'delete' then
    if issued > 0 then
      perform private.fail('整理券を発行した回は削除できません。受付を止める場合は一時停止を使ってください。', 'invalid');
    end if;
    delete from public.rounds where id = v_id;
    perform private.record(action, jsonb_build_object('id', v_id, 'label', r.label));
    return jsonb_build_object('ok', true);
  end if;
  perform private.fail('この操作は利用できません。', 'not_found');
  return null;
end $$;

create or replace function public.admin_list_tickets(p_round_id bigint, p_number integer default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_staff();
  if not exists (select 1 from public.rounds where id = p_round_id) then
    perform private.fail('この回は見つかりません。', 'not_found');
  end if;
  return jsonb_build_object('tickets', coalesce((
    select jsonb_agg(private.ticket_json(t, false, true) order by t.number desc)
    from public.tickets t
    where t.id in (select x.id from public.tickets x
                   where x.round_id = p_round_id and (p_number is null or x.number = p_number)
                   order by x.number desc limit 5000)), '[]'::jsonb));
end $$;

create or replace function public.admin_cancel(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.tickets;
begin
  perform private.require_staff();
  select * into t from public.tickets where id = p_id for update;
  if not found then perform private.fail('整理券が見つかりません。', 'not_found'); end if;
  if t.status = 'cancelled' then
    return jsonb_build_object('ticket', private.ticket_json(t, false, true), 'replayed', true);
  end if;
  update public.tickets set status = 'cancelled', cancelled_at = now(), cancelled_by = 'staff'
  where id = p_id returning * into t;
  perform private.record('staff_cancel', jsonb_build_object('ticket', t.id, 'round', t.round_id, 'number', t.number));
  return jsonb_build_object('ticket', private.ticket_json(t, false, true), 'replayed', false);
end $$;

create or replace function public.admin_export_tickets() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_staff();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'label', r.label, 'starts_time', r.starts_time, 'number', t.number, 'party_size', t.party_size,
      'status', t.status, 'created_at', private.iso(t.created_at),
      'cancelled_at', case when t.cancelled_at is null then null else private.iso(t.cancelled_at) end,
      'cancelled_by', t.cancelled_by, 'id', t.id) order by r.starts_time, r.id, t.number)
    from public.tickets t join public.rounds r on r.id = t.round_id), '[]'::jsonb);
end $$;

-- ---------- 実行権限 ----------

revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function
  public.public_state(), public.issue_ticket(bigint, integer, uuid, uuid), public.find_request(uuid, uuid),
  public.lookup_tickets(jsonb), public.cancel_ticket(uuid, text),
  public.admin_state(), public.admin_operation(jsonb), public.admin_list_tickets(bigint, integer),
  public.admin_cancel(uuid), public.admin_export_tickets()
from public, anon, authenticated;

grant execute on function
  public.public_state(), public.issue_ticket(bigint, integer, uuid, uuid), public.find_request(uuid, uuid),
  public.lookup_tickets(jsonb), public.cancel_ticket(uuid, text)
to anon, authenticated;

grant execute on function
  public.admin_state(), public.admin_operation(jsonb), public.admin_list_tickets(bigint, integer),
  public.admin_cancel(uuid), public.admin_export_tickets()
to authenticated;
