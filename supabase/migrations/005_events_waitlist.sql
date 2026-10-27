-- 紅華祭 整理券アプリ Supabase版 DB定義 v5：イベント（会場）・上演時間・時間の重なり・キャンセル待ち
-- 004_checkin.sql を実行したあとに、SQL Editor に全文を貼り付けて1回だけ実行します。
-- 回はイベントに属するようになるため、これまでの回と整理券（リハーサル分）はすべて消します。
-- ・1台のスマホは、開演〜終演の時間が重なる回の整理券を同時に持てない
-- ・満員の回は、受付時間内ならキャンセル待ちに登録できる。空きが出ると、開演まで登録順に自動で整理券を発行する
--   （先頭の人数分の空きがなければ、後ろの人も待つ）。キャンセル待ちの人がいる間、空いた席は一般の申し込みに出さない
-- ・繰り上がると、その人の時間が重なるほかのキャンセル待ちは自動で外れる

truncate public.tickets, public.rounds restart identity;

create table public.events (
  id bigint generated always as identity primary key,
  label text not null check (char_length(label) between 1 and 40),
  venue text not null default '' check (char_length(venue) <= 60),
  notice text not null default '' check (char_length(notice) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.rounds
  add column event_id bigint not null references public.events(id),
  add column duration_minutes integer not null default 60 check (duration_minutes between 1 and 600),
  add column waitlist_enabled boolean not null default true;
create index rounds_by_event on public.rounds(event_id);

create table public.waitlist (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity unique,
  round_id bigint not null references public.rounds(id),
  device_id uuid not null,
  request_id uuid not null unique,
  token text not null,
  party_size integer not null check (party_size between 1 and 20),
  preschool integer not null default 0 check (preschool between 0 and 20),
  elementary integer not null default 0 check (elementary between 0 and 20),
  junior_high integer not null default 0 check (junior_high between 0 and 20),
  high_school integer not null default 0 check (high_school between 0 and 20),
  guardians integer not null default 0 check (guardians between 0 and 10),
  status text not null default 'waiting' check (status in ('waiting', 'promoted', 'cancelled', 'removed', 'expired')),
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  ticket_id uuid references public.tickets(id)
);
create unique index waitlist_one_per_device on public.waitlist(round_id, device_id) where status = 'waiting';
create index waitlist_by_round on public.waitlist(round_id, status, seq);

alter table public.events enable row level security;
alter table public.waitlist enable row level security;
revoke all on public.events, public.waitlist from anon, authenticated;

-- ---------- 記録を守るトリガー ----------

create or replace function private.waitlist_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'キャンセル待ちの記録は削除できません。';
  end if;
  if old.status <> 'waiting' or new.status = 'waiting' or new.ended_at is null
     or new.id <> old.id or new.seq <> old.seq or new.round_id <> old.round_id or new.device_id <> old.device_id
     or new.request_id <> old.request_id or new.token <> old.token or new.party_size <> old.party_size
     or new.preschool <> old.preschool or new.elementary <> old.elementary
     or new.junior_high <> old.junior_high or new.high_school <> old.high_school
     or new.guardians <> old.guardians or new.created_at <> old.created_at
     or (new.status = 'promoted') <> (new.ticket_id is not null) then
    raise exception 'キャンセル待ちは状態の変更しかできません。';
  end if;
  return new;
end $$;
create trigger waitlist_guard before update or delete on public.waitlist
for each row execute function private.waitlist_guard();

create or replace function private.events_keep_used() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.rounds where event_id = old.id) then
    raise exception '回が登録されているイベントは削除できません。';
  end if;
  return old;
end $$;
create trigger events_keep_used before delete on public.events
for each row execute function private.events_keep_used();

-- ---------- 内部用の関数 ----------

create or replace function private.mins(p text) returns integer
language sql immutable set search_path = '' as $$
  select split_part(p, ':', 1)::integer * 60 + split_part(p, ':', 2)::integer
$$;

-- 開演〜終演（開演＋上演時間）が重なるか
create or replace function private.overlap(a public.rounds, b public.rounds) returns boolean
language sql immutable set search_path = '' as $$
  select private.mins(a.starts_time) < private.mins(b.starts_time) + b.duration_minutes
     and private.mins(b.starts_time) < private.mins(a.starts_time) + a.duration_minutes
$$;

-- その端末が持っている有効な整理券のうち、r と時間が重なる別の回（なければ id が null）
create or replace function private.overlapping_round(p_device uuid, r public.rounds) returns public.rounds
language sql stable set search_path = '' as $$
  select x.* from public.tickets t join public.rounds x on x.id = t.round_id
  where t.device_id = p_device and t.status = 'active' and x.id <> r.id and private.overlap(x, r)
  order by x.starts_time, x.id limit 1
$$;

create or replace function private.overlap_message(o public.rounds) returns text
language sql stable set search_path = '' as $$
  select format('時間が重なる回（%s %s・開演 %s）の整理券をお持ちです。先にそちらを取り消してください。',
    (select e.label from public.events e where e.id = o.event_id), o.label, o.starts_time)
$$;

-- 子どもの区分と保護者の人数を確かめて {preschool, elementary, junior_high, high_school, total, guardians} を返す
create or replace function private.party(p_children jsonb, p_guardians integer) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare kids jsonb; n_pre integer; n_ele integer; n_jun integer; n_hig integer; total integer; n_guardians integer := 0;
begin
  if jsonb_typeof(p_children) is distinct from 'object' then
    perform private.fail('人数を選んでください。', 'invalid');
  end if;
  kids := jsonb_build_object('preschool', 0, 'elementary', 0, 'junior_high', 0, 'high_school', 0) || p_children;
  n_pre := private.int_arg(kids, 'preschool', 0, 20, '未就学児の人数');
  n_ele := private.int_arg(kids, 'elementary', 0, 20, '小学生の人数');
  n_jun := private.int_arg(kids, 'junior_high', 0, 20, '中学生の人数');
  n_hig := private.int_arg(kids, 'high_school', 0, 20, '高校生の人数');
  total := n_pre + n_ele + n_jun + n_hig;
  if total < 1 then
    perform private.fail('子どもの人数を1名以上選んでください。', 'invalid');
  end if;
  if total > 20 then
    perform private.fail('人数は1〜20の整数で入力してください。', 'invalid');
  end if;
  if n_pre + n_ele > 0 then
    if p_guardians is null or p_guardians < 0 or p_guardians > 10 then
      perform private.fail('保護者の人数は0〜10の整数で入力してください。', 'invalid');
    end if;
    n_guardians := p_guardians;
  end if;
  return jsonb_build_object('preschool', n_pre, 'elementary', n_ele, 'junior_high', n_jun, 'high_school', n_hig, 'total', total, 'guardians', n_guardians);
end $$;

create or replace function private.events_json() returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'label', e.label, 'venue', e.venue, 'notice', e.notice) order by e.id), '[]'::jsonb)
  from public.events e
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
  e timestamptz := private.at(d, r.starts_time) + make_interval(mins => r.duration_minutes);
  used integer; active_n integer; cancelled_n integer; cancelled_p integer; last_n integer; guardians_n integer;
  checked_n integer; checked_p integer; checked_g integer;
  waiting_n integer; waiting_p integer; promoted_n integer;
  remaining integer; st text; result jsonb;
begin
  select coalesce(sum(t.party_size) filter (where t.status = 'active'), 0),
         count(*) filter (where t.status = 'active'),
         count(*) filter (where t.status = 'cancelled'),
         coalesce(sum(t.party_size) filter (where t.status = 'cancelled'), 0),
         coalesce(max(t.number), 0),
         coalesce(sum(t.guardians) filter (where t.status = 'active'), 0),
         count(*) filter (where t.status = 'active' and t.checked_in_at is not null),
         coalesce(sum(t.party_size) filter (where t.status = 'active' and t.checked_in_at is not null), 0),
         coalesce(sum(t.guardians) filter (where t.status = 'active' and t.checked_in_at is not null), 0)
    into used, active_n, cancelled_n, cancelled_p, last_n, guardians_n, checked_n, checked_p, checked_g
    from public.tickets t where t.round_id = r.id;
  select count(*) filter (where w.status = 'waiting' and v_now < s),
         coalesce(sum(w.party_size) filter (where w.status = 'waiting' and v_now < s), 0),
         count(*) filter (where w.status = 'promoted')
    into waiting_n, waiting_p, promoted_n
    from public.waitlist w where w.round_id = r.id;
  remaining := greatest(0, r.capacity_people - used);
  st := case
    when v_now >= f then 'finished'
    when v_now >= c then 'closed'
    when v_now < o then 'before'
    when r.paused then 'paused'
    when remaining < 1 or waiting_n > 0 then 'full'
    else 'open' end;
  result := jsonb_build_object(
    'id', r.id, 'event_id', r.event_id, 'label', r.label,
    'starts_time', r.starts_time, 'opens_time', r.opens_time, 'closes_time', r.closes_time,
    'ends_time', to_char(e at time zone 'Asia/Tokyo', 'HH24:MI'), 'duration_minutes', r.duration_minutes,
    'starts_at', private.iso(s), 'opens_at', private.iso(o), 'closes_at', private.iso(c), 'finishes_at', private.iso(f), 'ends_at', private.iso(e),
    'capacity_people', r.capacity_people, 'max_party', r.max_party,
    'remaining', case when p_admin or waiting_n = 0 then remaining else 0 end, 'status', st,
    'waiting_count', waiting_n, 'waitlist_open', r.waitlist_enabled and st = 'full');
  if p_admin then
    result := result || jsonb_build_object(
      'finish_after_minutes', r.finish_after_minutes, 'paused', r.paused, 'used_people', used,
      'active_count', active_n, 'cancelled_count', cancelled_n, 'cancelled_people', cancelled_p, 'last_number', last_n,
      'used_guardians', guardians_n,
      'checked_in_count', checked_n, 'checked_in_people', checked_p, 'checked_in_guardians', checked_g,
      'waitlist_enabled', r.waitlist_enabled, 'waiting_people', waiting_p, 'promoted_count', promoted_n);
  end if;
  return result;
end $$;

create or replace function private.ticket_json(t public.tickets, p_with_token boolean, p_admin boolean) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  r public.rounds; ev public.events;
  d text := private.event_date();
  s timestamptz; f timestamptz; result jsonb;
begin
  select * into r from public.rounds where id = t.round_id;
  select * into ev from public.events where id = r.event_id;
  s := private.at(d, r.starts_time);
  f := s + make_interval(mins => r.finish_after_minutes);
  result := jsonb_build_object(
    'id', t.id, 'round_id', t.round_id, 'round_label', r.label, 'starts_time', r.starts_time, 'starts_at', private.iso(s),
    'ends_time', to_char((s + make_interval(mins => r.duration_minutes)) at time zone 'Asia/Tokyo', 'HH24:MI'),
    'event_id', ev.id, 'event_label', ev.label, 'venue', ev.venue,
    'number', t.number, 'party_size', t.party_size,
    'children', jsonb_build_object('preschool', t.preschool, 'elementary', t.elementary, 'junior_high', t.junior_high, 'high_school', t.high_school),
    'guardians', t.guardians, 'status', t.status,
    'created_at', private.iso(t.created_at), 'cancelled_at', case when t.cancelled_at is null then null else private.iso(t.cancelled_at) end,
    'cancelled_by', t.cancelled_by,
    'checked_in_at', case when t.checked_in_at is null then null else private.iso(t.checked_in_at) end,
    'cancellable', t.status = 'active' and t.checked_in_at is null and now() < s,
    'round_finished', now() >= f);
  if p_with_token then result := result || jsonb_build_object('token', t.cancel_token, 'checkin_code', t.checkin_code); end if;
  if p_admin then result := result || jsonb_build_object('device', left(t.device_id::text, 8)); end if;
  return result;
end $$;

-- 開演を過ぎても待っていた記録は、繰り上げの処理が動く前でも「expired」として返す
create or replace function private.waitlist_json(w public.waitlist, p_with_token boolean, p_admin boolean) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  r public.rounds; ev public.events; t public.tickets;
  s timestamptz; st text := w.status; pos integer; result jsonb;
begin
  select * into r from public.rounds where id = w.round_id;
  select * into ev from public.events where id = r.event_id;
  s := private.at(private.event_date(), r.starts_time);
  if st = 'waiting' and now() >= s then st := 'expired'; end if;
  if st = 'waiting' then
    select count(*) into pos from public.waitlist x where x.round_id = w.round_id and x.status = 'waiting' and x.seq <= w.seq;
  end if;
  result := jsonb_build_object(
    'id', w.id, 'round_id', w.round_id, 'round_label', r.label, 'event_id', ev.id, 'event_label', ev.label, 'venue', ev.venue,
    'starts_time', r.starts_time, 'starts_at', private.iso(s),
    'ends_time', to_char((s + make_interval(mins => r.duration_minutes)) at time zone 'Asia/Tokyo', 'HH24:MI'),
    'party_size', w.party_size,
    'children', jsonb_build_object('preschool', w.preschool, 'elementary', w.elementary, 'junior_high', w.junior_high, 'high_school', w.high_school),
    'guardians', w.guardians, 'status', st, 'position', pos,
    'created_at', private.iso(w.created_at), 'ended_at', case when w.ended_at is null then null else private.iso(w.ended_at) end);
  if p_with_token then
    result := result || jsonb_build_object('token', w.token);
    if w.ticket_id is not null then
      select * into t from public.tickets where id = w.ticket_id;
      result := result || jsonb_build_object('ticket', private.ticket_json(t, true, false));
    end if;
  end if;
  if p_admin then
    result := result || jsonb_build_object('device', left(w.device_id::text, 8),
      'ticket_number', (select x.number from public.tickets x where x.id = w.ticket_id));
  end if;
  return result;
end $$;

-- その端末のキャンセル待ちのうち、r と時間が重なるものを外す（r 自身も含む）
create or replace function private.drop_overlapping_waits(p_device uuid, r public.rounds) returns void
language sql set search_path = '' as $$
  update public.waitlist x set status = 'removed', ended_at = now()
  from public.rounds y
  where y.id = x.round_id and x.device_id = p_device and x.status = 'waiting' and private.overlap(y, r)
$$;

-- 空きがあれば、キャンセル待ちの先頭から順に整理券を発行する。呼ぶ側で回の行をロックしておくこと。
create or replace function private.promote(p_round_id bigint) returns integer
language plpgsql set search_path = '' as $$
declare
  r public.rounds; w public.waitlist; created public.tickets;
  used integer; next_number integer; promoted integer := 0;
begin
  select * into r from public.rounds where id = p_round_id;
  if now() >= private.at(private.event_date(), r.starts_time) then
    update public.waitlist set status = 'expired', ended_at = now() where round_id = r.id and status = 'waiting';
    return 0;
  end if;
  loop
    select * into w from public.waitlist where round_id = r.id and status = 'waiting' order by seq limit 1 for update;
    exit when not found;
    if exists (select 1 from public.tickets where round_id = r.id and device_id = w.device_id and status = 'active')
       or (private.overlapping_round(w.device_id, r)).id is not null then
      update public.waitlist set status = 'removed', ended_at = now() where id = w.id;
      continue;
    end if;
    select coalesce(sum(party_size), 0) into used from public.tickets where round_id = r.id and status = 'active';
    exit when w.party_size > r.capacity_people - used;
    select coalesce(max(number), 0) + 1 into next_number from public.tickets where round_id = r.id;
    insert into public.tickets(round_id, number, party_size, preschool, elementary, junior_high, high_school, guardians, device_id, request_id, cancel_token)
    values (r.id, next_number, w.party_size, w.preschool, w.elementary, w.junior_high, w.high_school, w.guardians, w.device_id, gen_random_uuid(),
            replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
    returning * into created;
    update public.waitlist set status = 'promoted', ended_at = now(), ticket_id = created.id where id = w.id;
    perform private.drop_overlapping_waits(w.device_id, r);
    perform private.record('promote', jsonb_build_object('waitlist', w.id, 'ticket', created.id, 'round', r.id, 'number', created.number));
    promoted := promoted + 1;
  end loop;
  return promoted;
end $$;

-- ---------- 来場者向けの関数 ----------

create or replace function public.public_state() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'now', private.iso(now()),
    'eventDate', private.event_date(),
    'events', private.events_json(),
    'rounds', coalesce((select jsonb_agg(private.round_json(r, false) order by r.starts_time, r.id) from public.rounds r), '[]'::jsonb))
$$;

create or replace function public.issue_ticket(p_round_id bigint, p_children jsonb, p_guardians integer, p_device_id uuid, p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.rounds; v jsonb; st text; remaining integer; kids jsonb; total integer; o public.rounds;
  existing public.tickets; created public.tickets; next_number integer;
begin
  kids := private.party(p_children, p_guardians);
  total := (kids ->> 'total')::integer;
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
  if total > r.max_party then perform private.fail(format('1枚で申し込めるのは、子ども %s 名までです。', r.max_party), 'party'); end if;
  if total > remaining then perform private.fail(format('残りは子ども %s 名分です。人数を減らしてください。', remaining), 'remaining'); end if;
  if exists (select 1 from public.tickets where round_id = r.id and device_id = p_device_id and status = 'active') then
    perform private.fail('この回の整理券はすでにお持ちです。「整理券を見る」から確認してください。', 'already');
  end if;
  o := private.overlapping_round(p_device_id, r);
  if o.id is not null then perform private.fail(private.overlap_message(o), 'overlap'); end if;
  select coalesce(max(number), 0) + 1 into next_number from public.tickets where round_id = r.id;
  insert into public.tickets(round_id, number, party_size, preschool, elementary, junior_high, high_school, guardians, device_id, request_id, cancel_token)
  values (r.id, next_number, total, (kids ->> 'preschool')::integer, (kids ->> 'elementary')::integer, (kids ->> 'junior_high')::integer,
          (kids ->> 'high_school')::integer, (kids ->> 'guardians')::integer, p_device_id, p_request_id,
          replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
  returning * into created;
  perform private.drop_overlapping_waits(p_device_id, r);
  return jsonb_build_object('ticket', private.ticket_json(created, true, false), 'replayed', false);
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
  if t.checked_in_at is not null then
    perform private.fail('受付が済んだ整理券は取り消せません。', 'checked_in');
  end if;
  select * into r from public.rounds where id = t.round_id for update;
  if now() >= private.at(private.event_date(), r.starts_time) then
    perform private.fail('開演時刻を過ぎたため、この整理券は取り消せません。', 'started');
  end if;
  update public.tickets set status = 'cancelled', cancelled_at = now(), cancelled_by = 'visitor'
  where id = p_id returning * into t;
  perform private.promote(r.id);
  return jsonb_build_object('ticket', private.ticket_json(t, true, false), 'replayed', false);
end $$;

create or replace function public.join_waitlist(p_round_id bigint, p_children jsonb, p_guardians integer, p_device_id uuid, p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.rounds; v jsonb; st text; kids jsonb; total integer; o public.rounds;
  existing public.waitlist; created public.waitlist;
begin
  kids := private.party(p_children, p_guardians);
  total := (kids ->> 'total')::integer;
  select * into r from public.rounds where id = p_round_id for update;
  if not found then
    perform private.fail('この回は見つかりません。画面を再読み込みしてください。', 'not_found');
  end if;
  select * into existing from public.waitlist where request_id = p_request_id;
  if found then
    if existing.device_id <> p_device_id then
      perform private.fail('送信番号が重複しています。画面を再読み込みしてください。', 'request_conflict');
    end if;
    return jsonb_build_object('entry', private.waitlist_json(existing, true, false), 'replayed', true);
  end if;
  v := private.round_json(r, false);
  st := v ->> 'status';
  if not r.waitlist_enabled then perform private.fail('この回は、キャンセル待ちを受け付けていません。', 'waitlist_off'); end if;
  if st = 'open' then perform private.fail('まだ空きがあります。「整理券を取る」から申し込んでください。', 'open'); end if;
  if st <> 'full' then perform private.fail('キャンセル待ちは、受付時間内で満員のときだけ登録できます。', 'closed'); end if;
  if total > r.max_party then perform private.fail(format('1枚で申し込めるのは、子ども %s 名までです。', r.max_party), 'party'); end if;
  if exists (select 1 from public.tickets where round_id = r.id and device_id = p_device_id and status = 'active') then
    perform private.fail('この回の整理券はすでにお持ちです。「整理券を見る」から確認してください。', 'already');
  end if;
  if exists (select 1 from public.waitlist where round_id = r.id and device_id = p_device_id and status = 'waiting') then
    perform private.fail('この回のキャンセル待ちに、すでに登録しています。', 'already_waiting');
  end if;
  o := private.overlapping_round(p_device_id, r);
  if o.id is not null then perform private.fail(private.overlap_message(o), 'overlap'); end if;
  insert into public.waitlist(round_id, device_id, request_id, token, party_size, preschool, elementary, junior_high, high_school, guardians)
  values (r.id, p_device_id, p_request_id, replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
          total, (kids ->> 'preschool')::integer, (kids ->> 'elementary')::integer, (kids ->> 'junior_high')::integer,
          (kids ->> 'high_school')::integer, (kids ->> 'guardians')::integer)
  returning * into created;
  return jsonb_build_object('entry', private.waitlist_json(created, true, false), 'replayed', false);
end $$;

create or replace function public.lookup_waitlist(p_items jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  item jsonb; w public.waitlist; list jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 30 then
    perform private.fail('キャンセル待ちの情報を読み取れません。', 'invalid');
  end if;
  for item in select value from jsonb_array_elements(p_items) loop
    w := null;
    if coalesce(item ->> 'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select * into w from public.waitlist where id = (item ->> 'id')::uuid and token = coalesce(item ->> 'token', '');
    end if;
    list := list || jsonb_build_array(case when w.id is null then null else private.waitlist_json(w, true, false) end);
  end loop;
  return jsonb_build_object('now', private.iso(now()), 'entries', list);
end $$;

create or replace function public.leave_waitlist(p_id uuid, p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.waitlist; r public.rounds;
begin
  select * into w from public.waitlist where id = p_id;
  if not found or w.token <> coalesce(p_token, '') then
    perform private.fail('キャンセル待ちを確認できません。', 'forbidden');
  end if;
  select * into r from public.rounds where id = w.round_id for update;
  select * into w from public.waitlist where id = p_id for update;
  if w.status <> 'waiting' then
    return jsonb_build_object('entry', private.waitlist_json(w, true, false), 'replayed', true);
  end if;
  update public.waitlist set status = 'cancelled', ended_at = now() where id = p_id returning * into w;
  perform private.promote(r.id);
  return jsonb_build_object('entry', private.waitlist_json(w, true, false), 'replayed', false);
end $$;

-- ---------- 運営スタッフ向けの関数 ----------

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
    'events', private.events_json(),
    'rounds', rounds,
    'totals', jsonb_build_object(
      'tickets', coalesce((select sum((x ->> 'active_count')::integer) from jsonb_array_elements(rounds) x), 0),
      'people', coalesce((select sum((x ->> 'used_people')::integer) from jsonb_array_elements(rounds) x), 0),
      'guardians', coalesce((select sum((x ->> 'used_guardians')::integer) from jsonb_array_elements(rounds) x), 0),
      'cancelled', coalesce((select sum((x ->> 'cancelled_count')::integer) from jsonb_array_elements(rounds) x), 0),
      'capacity', coalesce((select sum((x ->> 'capacity_people')::integer) from jsonb_array_elements(rounds) x), 0),
      'remaining', coalesce((select sum((x ->> 'remaining')::integer) from jsonb_array_elements(rounds) x), 0),
      'checked_in', coalesce((select sum((x ->> 'checked_in_count')::integer) from jsonb_array_elements(rounds) x), 0),
      'checked_in_people', coalesce((select sum((x ->> 'checked_in_people')::integer) from jsonb_array_elements(rounds) x), 0),
      'checked_in_guardians', coalesce((select sum((x ->> 'checked_in_guardians')::integer) from jsonb_array_elements(rounds) x), 0),
      'waiting', coalesce((select sum((x ->> 'waiting_count')::integer) from jsonb_array_elements(rounds) x), 0),
      'promoted', coalesce((select sum((x ->> 'promoted_count')::integer) from jsonb_array_elements(rounds) x), 0)));
end $$;

create or replace function public.admin_operation(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  action text := p ->> 'action';
  v_label text; v_venue text; v_notice text; v_starts text; v_opens text; v_closes text;
  v_capacity integer; v_max integer; v_finish integer; v_duration integer; v_event bigint;
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

  if action in ('event_create', 'event_update') then
    v_label := btrim(coalesce(p ->> 'label', ''));
    v_venue := btrim(coalesce(p ->> 'venue', ''));
    v_notice := btrim(coalesce(p ->> 'notice', ''));
    if char_length(v_label) < 1 or char_length(v_label) > 40 then
      perform private.fail('イベントの名前は1〜40文字で入力してください。', 'invalid');
    end if;
    if char_length(v_venue) > 60 then perform private.fail('会場は60文字以内で入力してください。', 'invalid'); end if;
    if char_length(v_notice) > 1000 then perform private.fail('ご案内は1000文字以内で入力してください。', 'invalid'); end if;
    if action = 'event_create' then
      insert into public.events(label, venue, notice) values (v_label, v_venue, v_notice) returning id into new_id;
      perform private.record(action, jsonb_build_object('id', new_id, 'label', v_label));
      return jsonb_build_object('ok', true, 'id', new_id);
    end if;
    v_id := private.int_arg(p, 'id', 1, 2147483647, 'イベント');
    update public.events set label = v_label, venue = v_venue, notice = v_notice, updated_at = now() where id = v_id;
    if not found then perform private.fail('このイベントは見つかりません。', 'not_found'); end if;
    perform private.record(action, jsonb_build_object('id', v_id, 'label', v_label));
    return jsonb_build_object('ok', true);
  end if;
  if action = 'event_delete' then
    v_id := private.int_arg(p, 'id', 1, 2147483647, 'イベント');
    if exists (select 1 from public.rounds where event_id = v_id) then
      perform private.fail('このイベントには回が登録されているため削除できません。先に回を削除してください。', 'invalid');
    end if;
    delete from public.events where id = v_id;
    if not found then perform private.fail('このイベントは見つかりません。', 'not_found'); end if;
    perform private.record(action, jsonb_build_object('id', v_id));
    return jsonb_build_object('ok', true);
  end if;

  if action in ('create', 'update') then
    v_label := btrim(coalesce(p ->> 'label', ''));
    if char_length(v_label) < 1 or char_length(v_label) > 40 then
      perform private.fail('回の名前は1〜40文字で入力してください。', 'invalid');
    end if;
    v_event := private.int_arg(p, 'eventId', 1, 2147483647, 'イベント');
    if not exists (select 1 from public.events where id = v_event) then
      perform private.fail('イベントを選んでください。', 'invalid');
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
    v_duration := private.int_arg(p, 'durationMinutes', 1, 600, '上演時間（分）');
  end if;

  if action = 'create' then
    insert into public.rounds(event_id, label, starts_time, opens_time, closes_time, capacity_people, max_party, finish_after_minutes, duration_minutes)
    values (v_event, v_label, v_starts, v_opens, v_closes, v_capacity, v_max, v_finish, v_duration) returning id into new_id;
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
    update public.rounds set event_id = v_event, label = v_label, starts_time = v_starts, opens_time = v_opens, closes_time = v_closes,
      capacity_people = v_capacity, max_party = v_max, finish_after_minutes = v_finish, duration_minutes = v_duration, updated_at = now()
    where id = v_id;
    perform private.record(action, p);
    perform private.promote(v_id);
    return jsonb_build_object('ok', true);
  end if;
  if action in ('pause', 'resume') then
    update public.rounds set paused = (action = 'pause'), updated_at = now() where id = v_id;
    perform private.record(action, jsonb_build_object('id', v_id));
    return jsonb_build_object('ok', true);
  end if;
  if action in ('waitlist_on', 'waitlist_off') then
    update public.rounds set waitlist_enabled = (action = 'waitlist_on'), updated_at = now() where id = v_id;
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
  if t.checked_in_at is not null then
    perform private.fail('受付が済んだ整理券は取り消せません。', 'checked_in');
  end if;
  perform 1 from public.rounds where id = t.round_id for update;
  update public.tickets set status = 'cancelled', cancelled_at = now(), cancelled_by = 'staff'
  where id = p_id returning * into t;
  perform private.record('staff_cancel', jsonb_build_object('ticket', t.id, 'round', t.round_id, 'number', t.number));
  perform private.promote(t.round_id);
  return jsonb_build_object('ticket', private.ticket_json(t, false, true), 'replayed', false);
end $$;

-- 別の回の整理券だったときに、どのイベントの回かも伝える
create or replace function public.admin_checkin(p_round_id bigint, p_code text default null, p_number integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.rounds; other public.rounds; t public.tickets;
  d text; o timestamptz; f timestamptz;
begin
  perform private.require_staff();
  select * into r from public.rounds where id = p_round_id;
  if not found then perform private.fail('この回は見つかりません。', 'not_found'); end if;
  if p_code is not null then
    if p_code !~ '^[0-9a-f]{32}$' then
      perform private.fail('整理券のQRコードではありません。', 'invalid_code');
    end if;
    select * into t from public.tickets where checkin_code = p_code for update;
  elsif p_number is not null then
    select * into t from public.tickets where round_id = p_round_id and number = p_number for update;
  else
    perform private.fail('QRコードを読み取るか、整理券の番号を入力してください。', 'invalid');
  end if;
  if not found then
    perform private.fail(case when p_code is null then format('この回に No.%s の整理券はありません。', p_number) else 'この整理券は見つかりません。' end, 'not_found');
  end if;
  if t.round_id <> r.id then
    select * into other from public.rounds where id = t.round_id;
    perform private.fail(format('別の回（%s %s・開演 %s）の整理券です。',
      (select e.label from public.events e where e.id = other.event_id), other.label, other.starts_time), 'wrong_round');
  end if;
  if t.status = 'cancelled' then
    perform private.fail('取り消された整理券です。', 'cancelled');
  end if;
  if t.checked_in_at is not null then
    return jsonb_build_object('ticket', private.ticket_json(t, false, true), 'replayed', true);
  end if;
  d := private.event_date();
  o := private.at(d, r.opens_time);
  f := private.at(d, r.starts_time) + make_interval(mins => r.finish_after_minutes);
  if now() < o then
    perform private.fail(format('この回の受付は %s からです。', r.opens_time), 'before');
  end if;
  if now() >= f then
    perform private.fail('この回は終了しました。', 'finished');
  end if;
  update public.tickets set checked_in_at = now() where id = t.id returning * into t;
  perform private.record('checkin', jsonb_build_object('ticket', t.id, 'round', t.round_id, 'number', t.number));
  return jsonb_build_object('ticket', private.ticket_json(t, false, true), 'replayed', false);
end $$;

create or replace function public.admin_list_waitlist(p_round_id bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_staff();
  if not exists (select 1 from public.rounds where id = p_round_id) then
    perform private.fail('この回は見つかりません。', 'not_found');
  end if;
  return jsonb_build_object('entries', coalesce((
    select jsonb_agg(private.waitlist_json(w, false, true) order by w.seq)
    from public.waitlist w where w.id in (select x.id from public.waitlist x where x.round_id = p_round_id order by x.seq limit 5000)), '[]'::jsonb));
end $$;

create or replace function public.admin_export_tickets() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_staff();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'event_label', e.label, 'label', r.label, 'starts_time', r.starts_time, 'number', t.number, 'party_size', t.party_size,
      'preschool', t.preschool, 'elementary', t.elementary, 'junior_high', t.junior_high, 'high_school', t.high_school,
      'guardians', t.guardians,
      'status', t.status, 'created_at', private.iso(t.created_at),
      'via_waitlist', exists (select 1 from public.waitlist w where w.ticket_id = t.id),
      'checked_in_at', case when t.checked_in_at is null then null else private.iso(t.checked_in_at) end,
      'cancelled_at', case when t.cancelled_at is null then null else private.iso(t.cancelled_at) end,
      'cancelled_by', t.cancelled_by, 'id', t.id) order by e.id, r.starts_time, r.id, t.number)
    from public.tickets t join public.rounds r on r.id = t.round_id join public.events e on e.id = r.event_id), '[]'::jsonb);
end $$;

revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function
  public.join_waitlist(bigint, jsonb, integer, uuid, uuid), public.lookup_waitlist(jsonb), public.leave_waitlist(uuid, text),
  public.admin_list_waitlist(bigint)
from public, anon, authenticated;
grant execute on function
  public.join_waitlist(bigint, jsonb, integer, uuid, uuid), public.lookup_waitlist(jsonb), public.leave_waitlist(uuid, text)
to anon, authenticated;
grant execute on function public.admin_list_waitlist(bigint) to authenticated;
