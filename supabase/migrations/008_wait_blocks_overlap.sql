-- 紅華祭 整理券アプリ Supabase版 DB定義 v8：時間が重なるキャンセル待ちがあるときは、整理券を取れなくする
-- 007_list_all_tickets.sql を実行したあとに、SQL Editor に全文を貼り付けて1回だけ実行します。
-- これまでは整理券を取ると、時間が重なるキャンセル待ちが黙って外れていた。
-- 来場者が気づかずに順番を失わないよう、先にキャンセル待ちをやめてもらう。
-- キャンセル待ちから繰り上がったときは、これまでどおり重なるほかのキャンセル待ちを自動で外す。
-- 何度実行しても同じ結果になります。データは変更しません。

-- その端末が待っている、r と時間が重なる別の回（開演前のものだけ。なければ id が null）
create or replace function private.overlapping_wait(p_device uuid, r public.rounds) returns public.rounds
language sql stable set search_path = '' as $$
  select x.* from public.waitlist w join public.rounds x on x.id = w.round_id
  where w.device_id = p_device and w.status = 'waiting' and x.id <> r.id and private.overlap(x, r)
    and now() < private.at(private.event_date(), x.starts_time)
  order by x.starts_time, x.id limit 1
$$;

create or replace function private.wait_overlap_message(o public.rounds) returns text
language sql stable set search_path = '' as $$
  select format('時間が重なる回（%s %s・開演 %s）のキャンセル待ちをしているため、申し込めません。キャンセル待ちをやめると申し込めます。',
    (select e.label from public.events e where e.id = o.event_id), o.label, o.starts_time)
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

revoke execute on function private.overlapping_wait(uuid, public.rounds), private.wait_overlap_message(public.rounds) from public, anon, authenticated;
revoke execute on function public.issue_ticket(bigint, jsonb, integer, uuid, uuid) from public;
grant execute on function public.issue_ticket(bigint, jsonb, integer, uuid, uuid) to anon, authenticated;
