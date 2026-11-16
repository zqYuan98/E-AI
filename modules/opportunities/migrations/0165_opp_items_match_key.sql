-- 比对时用的“我司资质”的指纹：资质改了以后，还没截止的项目重新比。
ALTER TABLE opp_items ADD COLUMN match_key text NOT NULL DEFAULT '';
