-- 每天的总量（不含个人信息），永久保留；一天的明细过期删除时在同一事务里汇总进来。
CREATE TABLE usage_daily (
  day      date PRIMARY KEY,
  views    integer NOT NULL,
  visitors integer NOT NULL
);
