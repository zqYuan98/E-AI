-- 项目的资质、业绩、人员要求逐条和后台“我司资质”对比的结果（backend/match.ts）；没比过的为空。
ALTER TABLE opp_items ADD COLUMN match jsonb;
