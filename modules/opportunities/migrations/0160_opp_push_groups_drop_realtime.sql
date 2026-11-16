-- 实时推送改成早晚两次信息表（见 backend/push.ts），推送群不再有“实时推送”选项。
ALTER TABLE opp_push_groups DROP COLUMN IF EXISTS realtime;
