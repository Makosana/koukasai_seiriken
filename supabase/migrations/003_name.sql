-- 紅華祭 整理券アプリ Supabase版 DB定義 v3：申し込んだ人の名前
-- 002_children.sql を実行したあとに、SQL Editor に全文を貼り付けて1回だけ実行します。
-- v2 までに発行した整理券は名前が空（''）のまま残る。

alter table public.tickets
  add column name text not null default '' check (char_length(name) <= 30);

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
     or new.preschool <> old.preschool or new.elementary <> old.elementary
     or new.junior_high <> old.junior_high or new.high_school <> old.high_school
     or new.guardians <> old.guardians or new.name <> old.name
     or new.cancelled_at is null or new.cancelled_by is null then
    raise exception '整理券は取消以外の変更ができません。';
  end if;
  return new;
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
    'number', t.number, 'party_size', t.party_size,
    'children', jsonb_build_object('preschool', t.preschool, 'elementary', t.elementary, 'junior_high', t.junior_high, 'high_school', t.high_school),
    'guardians', t.guardians, 'name', t.name, 'status', t.status,
    'created_at', private.iso(t.created_at), 'cancelled_at', case when t.cancelled_at is null then null else private.iso(t.cancelled_at) end,
    'cancelled_by', t.cancelled_by,
    'cancellable', t.status = 'active' and now() < s,
    'round_finished', now() >= f);
  if p_with_token then result := result || jsonb_build_object('token', t.cancel_token); end if;
  if p_admin then result := result || jsonb_build_object('device', left(t.device_id::text, 8)); end if;
  return result;
end $$;

drop function public.issue_ticket(bigint, jsonb, integer, uuid, uuid);

create or replace function public.issue_ticket(p_round_id bigint, p_children jsonb, p_guardians integer, p_name text, p_device_id uuid, p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.rounds; v jsonb; st text; remaining integer;
  existing public.tickets; created public.tickets; next_number integer;
  kids jsonb; n_pre integer; n_ele integer; n_jun integer; n_hig integer; total integer; n_guardians integer := 0;
  v_name text := btrim(coalesce(p_name, ''));
begin
  if v_name = '' then
    perform private.fail('お名前を入力してください。', 'invalid');
  end if;
  if char_length(v_name) > 30 then
    perform private.fail('お名前は30文字以内で入力してください。', 'invalid');
  end if;
  if v_name ~ '[[:cntrl:]]' then
    perform private.fail('お名前に使えない文字が含まれています。', 'invalid');
  end if;
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
  insert into public.tickets(round_id, number, party_size, preschool, elementary, junior_high, high_school, guardians, name, device_id, request_id, cancel_token)
  values (r.id, next_number, total, n_pre, n_ele, n_jun, n_hig, n_guardians, v_name, p_device_id, p_request_id,
          replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
  returning * into created;
  return jsonb_build_object('ticket', private.ticket_json(created, true, false), 'replayed', false);
end $$;

create or replace function public.admin_export_tickets() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_staff();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'label', r.label, 'starts_time', r.starts_time, 'number', t.number, 'name', t.name, 'party_size', t.party_size,
      'preschool', t.preschool, 'elementary', t.elementary, 'junior_high', t.junior_high, 'high_school', t.high_school,
      'guardians', t.guardians,
      'status', t.status, 'created_at', private.iso(t.created_at),
      'cancelled_at', case when t.cancelled_at is null then null else private.iso(t.cancelled_at) end,
      'cancelled_by', t.cancelled_by, 'id', t.id) order by r.starts_time, r.id, t.number)
    from public.tickets t join public.rounds r on r.id = t.round_id), '[]'::jsonb);
end $$;

revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function public.issue_ticket(bigint, jsonb, integer, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.issue_ticket(bigint, jsonb, integer, text, uuid, uuid) to anon, authenticated;
