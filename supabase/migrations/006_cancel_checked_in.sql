-- 紅華祭 整理券アプリ Supabase版 DB定義 v6：受付済みの整理券のスタッフ取消（パスワード付き）
-- 005_events_waitlist.sql を実行したあとに、SQL Editor に全文を貼り付けて1回だけ実行します。
-- 受付済みの整理券は、スタッフが7桁の取消用パスワードを入れたときだけ取り消せる。
-- 受付した時刻（checked_in_at）は記録として残し、状態だけを取消にする。
-- パスワードはこのファイルに書かない（リポジトリは公開される）。実行後に SQL Editor で
--   select private.set_cancel_password('1234567');
-- を別に実行して設定する。保存するのは SHA-256 の値だけ。

create table private.secrets (
  key text primary key,
  value text not null
);
revoke all on private.secrets from public, anon, authenticated;

create or replace function private.set_cancel_password(p_password text) returns text
language plpgsql set search_path = '' as $$
begin
  if p_password is null or p_password !~ '^[0-9]{7}$' then
    raise exception '取消用のパスワードは7桁の数字にしてください。';
  end if;
  insert into private.secrets(key, value) values ('cancel_password', encode(sha256(convert_to(p_password, 'UTF8')), 'hex'))
  on conflict (key) do update set value = excluded.value;
  return '取消用のパスワードを設定しました。';
end $$;

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
  if old.status = 'active' and new.status = 'cancelled' and old.checked_in_at is not null
     and new.checked_in_at = old.checked_in_at and new.cancelled_at is not null and new.cancelled_by = 'staff' then
    return new;
  end if;
  if old.status = 'active' and new.status = 'active' and old.checked_in_at is null and new.checked_in_at is not null
     and new.cancelled_at is null and new.cancelled_by is null then
    return new;
  end if;
  raise exception '整理券は取消と受付以外の変更ができません。';
end $$;

create or replace function private.check_cancel_password(p_password text) returns void
language plpgsql stable set search_path = '' as $$
declare v_hash text;
begin
  select value into v_hash from private.secrets where key = 'cancel_password';
  if v_hash is null then
    perform private.fail('取消用のパスワードがまだ設定されていません。Supabase の SQL Editor で設定してください。', 'password');
  end if;
  if coalesce(p_password, '') = '' then
    perform private.fail('受付が済んだ整理券を取り消すには、取消用のパスワード（7桁）が必要です。', 'password');
  end if;
  if p_password !~ '^[0-9]{7}$' or encode(sha256(convert_to(p_password, 'UTF8')), 'hex') <> v_hash then
    perform private.fail('取消用のパスワードが違います。', 'password');
  end if;
end $$;

drop function public.admin_cancel(uuid);
create function public.admin_cancel(p_id uuid, p_password text default null) returns jsonb
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
    perform private.check_cancel_password(p_password);
  end if;
  perform 1 from public.rounds where id = t.round_id for update;
  update public.tickets set status = 'cancelled', cancelled_at = now(), cancelled_by = 'staff'
  where id = p_id returning * into t;
  perform private.record('staff_cancel', jsonb_build_object('ticket', t.id, 'round', t.round_id, 'number', t.number, 'checked_in', t.checked_in_at is not null));
  perform private.promote(t.round_id);
  return jsonb_build_object('ticket', private.ticket_json(t, false, true), 'replayed', false);
end $$;

revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function public.admin_cancel(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_cancel(uuid, text) to authenticated;
