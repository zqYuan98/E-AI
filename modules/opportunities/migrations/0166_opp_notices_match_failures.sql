-- 一份公告的要求比对失败次数，到 3 次不再自动试；后台改了“我司资质”时清零。
ALTER TABLE opp_notices ADD COLUMN match_failures integer NOT NULL DEFAULT 0;
