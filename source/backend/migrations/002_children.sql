-- 紅華祭 整理券アプリ DB定義 v2：子どもの区分と保護者の人数
-- party_size は子どもの合計（定員と1枚の上限に数える）。guardians は定員に数えない。

ALTER TABLE tickets ADD COLUMN preschool INTEGER NOT NULL DEFAULT 0 CHECK (preschool BETWEEN 0 AND 20);
ALTER TABLE tickets ADD COLUMN elementary INTEGER NOT NULL DEFAULT 0 CHECK (elementary BETWEEN 0 AND 20);
ALTER TABLE tickets ADD COLUMN junior_high INTEGER NOT NULL DEFAULT 0 CHECK (junior_high BETWEEN 0 AND 20);
ALTER TABLE tickets ADD COLUMN high_school INTEGER NOT NULL DEFAULT 0 CHECK (high_school BETWEEN 0 AND 20);
ALTER TABLE tickets ADD COLUMN guardians INTEGER NOT NULL DEFAULT 0 CHECK (guardians BETWEEN 0 AND 10);

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
    OR NEW.guardians <> OLD.guardians
    OR NEW.cancelled_at IS NULL OR NEW.cancelled_by IS NULL
  THEN RAISE(ABORT, '整理券は取消以外の変更ができません。') END;
END;
