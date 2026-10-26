-- 紅華祭 整理券アプリ DB定義 v1
-- 定義を変えると既存データとの照合に失敗し、安全のため起動を停止します。

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  starts_time TEXT NOT NULL CHECK (starts_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  opens_time TEXT NOT NULL CHECK (opens_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  closes_time TEXT NOT NULL CHECK (closes_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  capacity_people INTEGER NOT NULL CHECK (capacity_people BETWEEN 1 AND 10000),
  max_party INTEGER NOT NULL DEFAULT 4 CHECK (max_party BETWEEN 1 AND 20),
  finish_after_minutes INTEGER NOT NULL DEFAULT 30 CHECK (finish_after_minutes BETWEEN 0 AND 600),
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (opens_time < closes_time)
);

CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  number INTEGER NOT NULL CHECK (number >= 1),
  party_size INTEGER NOT NULL CHECK (party_size BETWEEN 1 AND 20),
  device_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  cancel_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at TEXT NOT NULL,
  cancelled_at TEXT,
  cancelled_by TEXT CHECK (cancelled_by IN ('visitor', 'staff')),
  UNIQUE (round_id, number)
);

-- 1つの端末が同じ回で有効な整理券を2枚持てないようにする
CREATE UNIQUE INDEX tickets_one_active_per_device ON tickets(round_id, device_id) WHERE status = 'active';
CREATE INDEX tickets_by_round ON tickets(round_id, status);

CREATE TABLE operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT NOT NULL
);

CREATE TRIGGER tickets_no_delete BEFORE DELETE ON tickets
BEGIN
  SELECT RAISE(ABORT, '整理券の記録は削除できません。');
END;

CREATE TRIGGER tickets_cancel_only BEFORE UPDATE ON tickets
BEGIN
  SELECT CASE WHEN
    OLD.status <> 'active' OR NEW.status <> 'cancelled'
    OR NEW.id <> OLD.id OR NEW.round_id <> OLD.round_id OR NEW.number <> OLD.number
    OR NEW.party_size <> OLD.party_size OR NEW.device_id <> OLD.device_id
    OR NEW.request_id <> OLD.request_id OR NEW.cancel_token <> OLD.cancel_token
    OR NEW.created_at <> OLD.created_at
    OR NEW.cancelled_at IS NULL OR NEW.cancelled_by IS NULL
  THEN RAISE(ABORT, '整理券は取消以外の変更ができません。') END;
END;

CREATE TRIGGER rounds_keep_issued BEFORE DELETE ON rounds
WHEN EXISTS (SELECT 1 FROM tickets WHERE round_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, '整理券を発行した回は削除できません。');
END;

CREATE TRIGGER operations_no_update BEFORE UPDATE ON operations
BEGIN
  SELECT RAISE(ABORT, '操作記録は変更できません。');
END;

CREATE TRIGGER operations_no_delete BEFORE DELETE ON operations
BEGIN
  SELECT RAISE(ABORT, '操作記録は削除できません。');
END;
