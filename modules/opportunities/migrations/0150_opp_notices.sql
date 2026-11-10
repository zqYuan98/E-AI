-- 项目商机（modules/opportunities）：采集服务发现的国网公告，一条公告一行。时间、批次、采购人照抄来源原文；
-- backfill 是第一轮采集时已经在列表上的存量，只入库、不实时推送。
CREATE TABLE opp_notices (
  id              text PRIMARY KEY,
  source          text NOT NULL,
  category        text NOT NULL DEFAULT '',
  url             text NOT NULL,
  title           text NOT NULL,
  batch           text NOT NULL DEFAULT '',
  buyer           text NOT NULL DEFAULT '',
  published       text NOT NULL DEFAULT '',
  file_deadline   text NOT NULL DEFAULT '',
  opening_time    text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'pending',
  error           text NOT NULL DEFAULT '',
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  file_sha256     text NOT NULL DEFAULT '',
  item_count      integer NOT NULL DEFAULT 0,
  package_count   integer NOT NULL DEFAULT 0,
  warnings        jsonb NOT NULL DEFAULT '[]',
  screened        boolean NOT NULL DEFAULT false,
  screen_failures integer NOT NULL DEFAULT 0,
  backfill        boolean NOT NULL DEFAULT false,
  discovered_at   timestamptz NOT NULL DEFAULT now(),
  fetched_at      timestamptz,
  pushed_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
