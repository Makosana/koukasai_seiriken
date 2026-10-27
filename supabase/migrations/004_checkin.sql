-- 紅華祭 整理券アプリ Supabase版 DB定義 v4：入場受付（QRコード）と名前の廃止
-- 003_name.sql を実行したあとに、SQL Editor に全文を貼り付けて1回だけ実行します。
-- 来場者の整理券に受付用のコード（checkin_code）を持たせ、運営画面で読み取ると checked_in_at が入る。
-- checkin_code は取消用の cancel_token とは別物で、知られても整理券の表示・取消はできない。
-- 名前の列は、記録済みの名前ごと削除する。

alter table public.tickets
  add column checkin_code text not null default replace(gen_random_uuid()::text, '-', '') check (checkin_code ~ '^[0-9a-f]{32}$'),
  add column checked_in_at timestamptz;
alter table public.tickets add constraint tickets_checkin_code_key unique (checkin_code);

-- 変更できるのは「有効 → 取消」（受付前のみ）と「有効 → 受付済み」の2通りだけ
create or replace function private.tickets_cancel_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception '整理券の記録は削除できません。';
  end if;
  if new.id <> old.id or new.round_id <> old.round_id or new.number <> old.number
     or new.party_size <> old.party_size or new.device_id <> old.device_id
     or new.request_id <> old.request_id or new.cancel_token <> old.cancel_token
     or new.created_at <> old.created_at
     or new.preschool <> old.preschool or new.elementary <> old.elementary
     or new.junior_high <> old.junior_high or new.high_school <> old.high_school
     or new.guardians <> old.guardians or new.checkin_code <> old.checkin_code then
    raise exception '整理券は取消と受付以外の変更ができません。';
  end if;
  if old.status = 'active' and new.status = 'cancelled' and old.checked_in_at is null and new.checked_in_at is null
     and new.cancelled_at is not null and new.cancelled_by is not null then
    return new;
  end if;
  if old.status = 'active' and new.status = 'active' and old.checked_in_at is null and new.checked_in_at is not null
     and new.cancelled_at is null and new.cancelled_by is null then
    return new;
  end if;
  raise exception '整理券は取消と受付以外の変更ができません。';
end $$;

create or replace function private.round_json(r public.rounds, p_admin boolean) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  d text := private.event_date();
  v_now timestamptz := now();
  s timestamptz := private.at(d, r.starts_time);
  o timestamptz := private.at(d, r.opens_time);
  c timestamptz := private.at(d, r.closes_time);
  f timestamptz := private.at(d, r.starts_time) + make_interval(mins => r.finish_after_minutes);
  used integer; active_n integer; cancelled_n integer; cancelled_p integer; last_n integer; guardians_n integer;
  checked_n integer; checked_p integer; checked_g integer;
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
      'active_count', active_n, 'cancelled_count', cancelled_n, 'cancelled_people', cancelled_p, 'last_number', last_n,
      'used_guardians', guardians_n,
      'checked_in_count', checked_n, 'checked_in_people', checked_p, 'checked_in_guardians', checked_g);
  end if;
  return result;
end $$;

-- checkin_code は整理券の持ち主（token を知っている人）にだけ返す
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

drop function public.issue_ticket(bigint, jsonb, integer, text, uuid, uuid);

create or replace function public.issue_ticket(p_round_id bigint, p_children jsonb, p_guardians integer, p_device_id uuid, p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.rounds; v jsonb; st text; remaining integer;
  existing public.tickets; created public.tickets; next_number integer;
  kids jsonb; n_pre integer; n_ele integer; n_jun integer; n_hig integer; total integer; n_guardians integer := 0;
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
  select coalesce(max(number), 0) + 1 into next_number from public.tickets where round_id = r.id;
  insert into public.tickets(round_id, number, party_size, preschool, elementary, junior_high, high_school, guardians, device_id, request_id, cancel_token)
  values (r.id, next_number, total, n_pre, n_ele, n_jun, n_hig, n_guardians, p_device_id, p_request_id,
          replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
  returning * into created;
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
  select * into r from public.rounds where id = t.round_id;
  if now() >= private.at(private.event_date(), r.starts_time) then
    perform private.fail('開演時刻を過ぎたため、この整理券は取り消せません。', 'started');
  end if;
  update public.tickets set status = 'cancelled', cancelled_at = now(), cancelled_by = 'visitor'
  where id = p_id returning * into t;
  return jsonb_build_object('ticket', private.ticket_json(t, true, false), 'replayed', false);
end $$;

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
      'guardians', coalesce((select sum((x ->> 'used_guardians')::integer) from jsonb_array_elements(rounds) x), 0),
      'cancelled', coalesce((select sum((x ->> 'cancelled_count')::integer) from jsonb_array_elements(rounds) x), 0),
      'capacity', coalesce((select sum((x ->> 'capacity_people')::integer) from jsonb_array_elements(rounds) x), 0),
      'remaining', coalesce((select sum((x ->> 'remaining')::integer) from jsonb_array_elements(rounds) x), 0),
      'checked_in', coalesce((select sum((x ->> 'checked_in_count')::integer) from jsonb_array_elements(rounds) x), 0),
      'checked_in_people', coalesce((select sum((x ->> 'checked_in_people')::integer) from jsonb_array_elements(rounds) x), 0),
      'checked_in_guardians', coalesce((select sum((x ->> 'checked_in_guardians')::integer) from jsonb_array_elements(rounds) x), 0)));
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
  update public.tickets set status = 'cancelled', cancelled_at = now(), cancelled_by = 'staff'
  where id = p_id returning * into t;
  perform private.record('staff_cancel', jsonb_build_object('ticket', t.id, 'round', t.round_id, 'number', t.number));
  return jsonb_build_object('ticket', private.ticket_json(t, false, true), 'replayed', false);
end $$;

-- 入場受付。p_code（QRコードの中身）か p_number（選んだ回の整理券番号）のどちらかで探す。
-- 受付できるのは、選んだ回の整理券を、その回の受付開始から「終了した回」になるまでの間だけ。
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
    perform private.fail(format('別の回（%s・開演 %s）の整理券です。', other.label, other.starts_time), 'wrong_round');
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

create or replace function public.admin_export_tickets() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_staff();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'label', r.label, 'starts_time', r.starts_time, 'number', t.number, 'party_size', t.party_size,
      'preschool', t.preschool, 'elementary', t.elementary, 'junior_high', t.junior_high, 'high_school', t.high_school,
      'guardians', t.guardians,
      'status', t.status, 'created_at', private.iso(t.created_at),
      'checked_in_at', case when t.checked_in_at is null then null else private.iso(t.checked_in_at) end,
      'cancelled_at', case when t.cancelled_at is null then null else private.iso(t.cancelled_at) end,
      'cancelled_by', t.cancelled_by, 'id', t.id) order by r.starts_time, r.id, t.number)
    from public.tickets t join public.rounds r on r.id = t.round_id), '[]'::jsonb);
end $$;

alter table public.tickets drop column name;

revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function
  public.issue_ticket(bigint, jsonb, integer, uuid, uuid), public.admin_checkin(bigint, text, integer)
from public, anon, authenticated;
grant execute on function public.issue_ticket(bigint, jsonb, integer, uuid, uuid) to anon, authenticated;
grant execute on function public.admin_checkin(bigint, text, integer) to authenticated;
