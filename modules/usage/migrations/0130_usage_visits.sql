-- 访问统计（modules/usage）：成员每打开一个页面记一行。只存成员、页面路径（不带查询参数）、页面标题和设备类型；
-- 不存 IP 和页面内容。个人明细保留 180 天，过期前按天汇总进 usage_daily。
CREATE TABLE usage_visits (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  day         date NOT NULL,
  member_id   integer NOT NULL,
  member_name text NOT NULL,
  path        text NOT NULL,
  title       text NOT NULL DEFAULT '',
  device      text NOT NULL CHECK (device IN ('mobile', 'desktop'))
);
