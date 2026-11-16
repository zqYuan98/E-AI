-- 实时推送去掉后，哪个群收到过哪份公告只看 opp_pushes 里的 g<群>:notice:<公告>，不再有“推送处理完”的时间。
ALTER TABLE opp_notices DROP COLUMN IF EXISTS pushed_at;
