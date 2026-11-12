-- 推送群：每个钉钉群一个自定义机器人（加签），后台“投标商机”里添加。各群自己选推哪些业务方向和来源、要不要待确认、
-- 实时推送和每日汇总，以及提醒人（姓名、手机号、关注的方向）。只实时推 enabled_at 之后发现的公告，新加或重新启用的群不补发旧的。
CREATE TABLE opp_push_groups (
  id            serial PRIMARY KEY,
  name          text NOT NULL,
  webhook       text NOT NULL,
  secret        text NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  lines         jsonb NOT NULL DEFAULT '[]',
  sources       jsonb NOT NULL DEFAULT '[]',
  include_maybe boolean NOT NULL DEFAULT true,
  realtime      boolean NOT NULL DEFAULT true,
  digest        boolean NOT NULL DEFAULT true,
  mentions      jsonb NOT NULL DEFAULT '[]',
  enabled_at    timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
