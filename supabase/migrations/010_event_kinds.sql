-- 紅華祭 整理券アプリ Supabase版 DB定義 v10：イベントごとの対象（子どもの区分）
-- 009_wait_partial.sql を実行したあとに、SQL Editor に全文を貼り付けて1回だけ実行します。
-- イベントごとに、申し込める子どもの区分（未就学児・小学生・中学生・高校生）を決められるようにする。
-- これまでのイベントは、4つの区分すべてが対象になります。データは消しません。
-- 対象をあとから変えても、すでに発行した整理券とキャンセル待ちはそのまま残る（繰り上げも止めない）。

alter table public.events
  add column kinds text[] not null default array['preschool', 'elementary', 'junior_high', 'high_school']
  check (cardinality(kinds) between 1 and 4 and kinds <@ array['preschool', 'elementary', 'junior_high', 'high_school']);

create or replace function private.events_json() returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'label', e.label, 'venue', e.venue, 'notice', e.notice, 'kinds', to_jsonb(e.kinds)) order by e.id), '[]'::jsonb)
  from public.events e
$$;

-- p の kinds を確かめて返す。kinds が無いときは null（古い画面からの保存では対象を変えない）
create or replace function private.kinds_arg(p jsonb) returns text[]
language plpgsql immutable set search_path = '' as $$
declare k text[];
begin
  if not (p ? 'kinds') then return null; end if;
  if jsonb_typeof(p -> 'kinds') is distinct from 'array' then
    perform private.fail('対象の区分を選んでください。', 'invalid');
  end if;
  select array_agg(x order by array_position(array['preschool', 'elementary', 'junior_high', 'high_school'], x))
    into k from (select distinct value as x from jsonb_array_elements_text(p -> 'kinds')) s;
  if k is null or cardinality(k) < 1 then
    perform private.fail('対象の区分を1つ以上選んでください。', 'invalid');
  end if;
  if not (k <@ array['preschool', 'elementary', 'junior_high', 'high_school']) then
    perform private.fail('対象の区分を読み取れません。', 'invalid');
  end if;
  return k;
end $$;

-- 回のイベントで対象外の区分が入っていれば断る
create or replace function private.check_kinds(r public.rounds, kids jsonb) returns void
language plpgsql stable set search_path = '' as $$
declare allowed text[]; ng text;
begin
  select e.kinds into allowed from public.events e where e.id = r.event_id;
  select string_agg(l, '・' order by o) into ng
  from (values ('preschool', '未就学児', 1), ('elementary', '小学生', 2), ('junior_high', '中学生', 3), ('high_school', '高校生', 4)) v(k, l, o)
  where coalesce((kids ->> k)::integer, 0) > 0 and not (k = any(allowed));
  if ng is not null then
    perform private.fail(format('このイベントは、%sは対象外です。人数を選び直してください。', ng), 'kinds');
  end if;
end $$;

-- 運営操作：イベントの追加・更新で対象も保存する。ほかの操作はこれまでの処理に任せる
alter function public.admin_operation(jsonb) set schema private;
alter function private.admin_operation(jsonb) rename to admin_operation_base;

create function public.admin_operation(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare action text := p ->> 'action'; v_kinds text[]; v_id bigint; result jsonb;
begin
  perform private.require_staff();
  if action in ('event_create', 'event_update') then
    v_kinds := private.kinds_arg(p);
    result := private.admin_operation_base(p);
    if v_kinds is not null then
      v_id := case when action = 'event_create' then (result ->> 'id')::bigint else (p ->> 'id')::bigint end;
      update public.events set kinds = v_kinds where id = v_id;
    end if;
    return result;
  end if;
  return private.admin_operation_base(p);
end $$;

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
  perform private.check_kinds(r, kids);
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
  o := private.overlapping_wait(p_device_id, r);
  if o.id is not null then perform private.fail(private.wait_overlap_message(o), 'wait_overlap'); end if;
  select coalesce(max(number), 0) + 1 into next_number from public.tickets where round_id = r.id;
  insert into public.tickets(round_id, number, party_size, preschool, elementary, junior_high, high_school, guardians, device_id, request_id, cancel_token)
  values (r.id, next_number, total, (kids ->> 'preschool')::integer, (kids ->> 'elementary')::integer, (kids ->> 'junior_high')::integer,
          (kids ->> 'high_school')::integer, (kids ->> 'guardians')::integer, p_device_id, p_request_id,
          replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
  returning * into created;
  perform private.drop_overlapping_waits(p_device_id, r);
  return jsonb_build_object('ticket', private.ticket_json(created, true, false), 'replayed', false);
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
  perform private.check_kinds(r, kids);
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

revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function public.admin_operation(jsonb) from public, anon, authenticated;
grant execute on function public.admin_operation(jsonb) to authenticated;
