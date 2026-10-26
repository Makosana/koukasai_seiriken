-- 紅華祭 整理券アプリ DB定義 v3：申し込んだ人の名前
-- v2 までに発行した整理券は名前が空（''）のまま残る。

ALTER TABLE tickets ADD COLUMN name TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 30);

DROP TRIGGER tickets_cancel_only;
CREATE TRIGGER tickets_cancel_only BEFORE UPDATE ON tickets
BEGIN
  SELECT CASE WHEN
    OLD.status <> 'active' OR NEW.status <> 'cancelled'
    OR NEW.id <> OLD.id OR NEW.round_id <> OLD.round_id OR NEW.number <> OLD.number
    OR NEW.party_size <> OLD.party_size OR NEW.device_id <> OLD.device_id
    OR NEW.request_id <> OLD.request_id OR NEW.cancel_token <> OLD.cancel_token
    OR NEW.created_at <> OLD.created_at
    OR NEW.preschool <> OLD.preschool OR NEW.elementary <> OLD.elementary
    OR NEW.junior_high <> OLD.junior_high OR NEW.high_school <> OLD.high_school
    OR NEW.guardians <> OLD.guardians OR NEW.name <> OLD.name
    OR NEW.cancelled_at IS NULL OR NEW.cancelled_by IS NULL
  THEN RAISE(ABORT, '整理券は取消以外の変更ができません。') END;
END;
