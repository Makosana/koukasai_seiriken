-- 紅華祭 整理券アプリ DB定義 v5：イベント（会場）と上演時間
-- 回はイベントに属する。これまでの回は「ステージ公演」というイベントにまとめる（整理券は消さない）。

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  venue TEXT NOT NULL DEFAULT '' CHECK (length(venue) <= 60),
  notice TEXT NOT NULL DEFAULT '' CHECK (length(notice) <= 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO events(label, created_at, updated_at)
SELECT 'ステージ公演', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM rounds);

ALTER TABLE rounds ADD COLUMN event_id INTEGER REFERENCES events(id);
ALTER TABLE rounds ADD COLUMN duration_minutes INTEGER NOT NULL DEFAULT 60 CHECK (duration_minutes BETWEEN 1 AND 600);
UPDATE rounds SET event_id = (SELECT MIN(id) FROM events);
CREATE INDEX rounds_by_event ON rounds(event_id);

CREATE TRIGGER events_keep_used BEFORE DELETE ON events
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM rounds WHERE event_id = OLD.id)
  THEN RAISE(ABORT, '回が登録されているイベントは削除できません。') END;
END;
