-- 抽要素失败的次数；模型临时出错时下一轮再试，取到附件 6 小时后不再等它推送。
ALTER TABLE opp_notices ADD COLUMN details_failures integer NOT NULL DEFAULT 0;
