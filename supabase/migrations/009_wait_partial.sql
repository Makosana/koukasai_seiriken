-- 紅華祭 整理券アプリ Supabase版 DB定義 v9：残りより多い人数でもキャンセル待ちに登録できるようにする
-- 008_wait_blocks_overlap.sql を実行したあとに、SQL Editor に全文を貼り付けて1回だけ実行します。
-- ・空きが残っていても、申し込む人数が残りより多ければキャンセル待ちに登録できる
-- ・キャンセル待ちの人がいても、空きがある間は「受付中」のまま。空きに入る人数なら整理券を取れる
-- ・繰り上げは登録順に見ていき、空きに入る人数の人から発行する（入らない人は順番を保って待つ）
-- 何度実行しても同じ結果になります。データは変更しません。

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
    when remaining < 1 then 'full'
    else 'open' end;
  result := jsonb_build_object(
    'id', r.id, 'event_id', r.event_id, 'label', r.label,
    'starts_time', r.starts_time, 'opens_time', r.opens_time, 'closes_time', r.closes_time,
    'ends_time', to_char(e at time zone 'Asia/Tokyo', 'HH24:MI'), 'duration_minutes', r.duration_minutes,
    'starts_at', private.iso(s), 'opens_at', private.iso(o), 'closes_at', private.iso(c), 'finishes_at', private.iso(f), 'ends_at', private.iso(e),
    'capacity_people', r.capacity_people, 'max_party', r.max_party,
    'remaining', remaining, 'status', st,
    'waiting_count', waiting_n,
    'waitlist_open', r.waitlist_enabled and (st = 'full' or (st = 'open' and remaining < r.max_party)));
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

-- 空きがあれば、キャンセル待ちを登録順に見て、空きに入る人数の人から整理券を発行する。呼ぶ側で回の行をロックしておくこと。
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
  for w in select * from public.waitlist where round_id = r.id and status = 'waiting' order by seq for update loop
    -- 前の人の繰り上げで、時間が重なるとして外れていることがある
    continue when not exists (select 1 from public.waitlist x where x.id = w.id and x.status = 'waiting');
    if exists (select 1 from public.tickets where round_id = r.id and device_id = w.device_id and status = 'active')
       or (private.overlapping_round(w.device_id, r)).id is not null then
      update public.waitlist set status = 'removed', ended_at = now() where id = w.id;
      continue;
    end if;
    select coalesce(sum(party_size), 0) into used from public.tickets where round_id = r.id and status = 'active';
    exit when used >= r.capacity_people;
    continue when w.party_size > r.capacity_people - used;
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
  if st = 'open' and total <= (v ->> 'remaining')::integer then
    perform private.fail('まだ空きがあります。「整理券を取る」から申し込んでください。', 'open');
  end if;
  if st not in ('open', 'full') then perform private.fail('キャンセル待ちは、受付時間内だけ登録できます。', 'closed'); end if;
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

revoke execute on function private.round_json(public.rounds, boolean), private.promote(bigint) from public, anon, authenticated;
revoke execute on function public.join_waitlist(bigint, jsonb, integer, uuid, uuid) from public;
grant execute on function public.join_waitlist(bigint, jsonb, integer, uuid, uuid) to anon, authenticated;
