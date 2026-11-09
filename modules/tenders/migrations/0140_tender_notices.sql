-- 招采信源（标签“招标”“中标”“招标计划”）的每篇资料一行：抽取到哪一步、模型的抽取结果。
-- seq 每次有变化（新登记、抽取完成）都取一个新值，天枢按它增量拉取（backend/feed.ts）。
CREATE TABLE tender_notices (
  article_id  text PRIMARY KEY,
  seq         bigserial NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'skipped', 'done', 'failed')),
  attempts    integer NOT NULL DEFAULT 0,
  extraction  jsonb,
  receipt_id  bigint,
  checked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
)
