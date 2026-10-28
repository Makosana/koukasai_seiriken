-- 紅華祭 整理券アプリ Supabase版 DB定義 v7：整理券の一覧で「すべてのイベント」を選べるようにする
-- 006_cancel_checked_in.sql を実行したあとに、SQL Editor に全文を貼り付けて1回だけ実行します。
-- p_round_id に null を渡すと、すべての回の整理券を新しい順に返す（番号を指定すると全回の同じ番号）。
-- 何度実行しても同じ結果になります。データは変更しません。

create or replace function public.admin_list_tickets(p_round_id bigint, p_number integer default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_staff();
  if p_round_id is null then
    return jsonb_build_object('tickets', coalesce((
      select jsonb_agg(private.ticket_json(t, false, true) order by t.created_at desc, t.number desc)
      from public.tickets t
      where t.id in (select x.id from public.tickets x
                     where p_number is null or x.number = p_number
                     order by x.created_at desc, x.number desc limit 5000)), '[]'::jsonb));
  end if;
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

revoke execute on function public.admin_list_tickets(bigint, integer) from public, anon, authenticated;
grant execute on function public.admin_list_tickets(bigint, integer) to authenticated;
