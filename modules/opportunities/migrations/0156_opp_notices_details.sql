-- 模型从公告正文抽出的要素（预算、时间、资格、业绩、人员，各带原话），原话核对不上的已经去掉；没抽过为空。
ALTER TABLE opp_notices ADD COLUMN details jsonb;
