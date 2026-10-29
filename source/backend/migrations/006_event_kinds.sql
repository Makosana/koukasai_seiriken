-- 紅華祭 整理券アプリ DB定義 v6：イベントごとの対象（子どもの区分）
-- カンマ区切りで、申し込める区分を記録する。これまでのイベントは4つの区分すべてが対象。

ALTER TABLE events ADD COLUMN kinds TEXT NOT NULL DEFAULT 'preschool,elementary,junior_high,high_school'
  CHECK (length(kinds) BETWEEN 1 AND 60);
