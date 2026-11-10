-- 推到钉钉群的消息，一条公告或一天的汇总一行，防止重复推送。结果不明（unknown）的不自动重发。
CREATE TABLE opp_pushes (
  key        text PRIMARY KEY,
  status     text NOT NULL,
  attempts   integer NOT NULL DEFAULT 0,
  error      text NOT NULL DEFAULT '',
  sent_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
