-- 每日 8:30 汇总并进早晚两次信息表，推送群不再有“每日汇总”选项。
ALTER TABLE opp_push_groups DROP COLUMN IF EXISTS digest;
