-- 从宜搭“资质/荣誉台账”同步来的我司资质（backend/yida.ts），每次同步整表替换；id 是宜搭的表单实例 ID。
CREATE TABLE opp_company_quals (id text PRIMARY KEY, company text NOT NULL, kind text NOT NULL DEFAULT '', name text NOT NULL, valid_from text NOT NULL DEFAULT '', valid_to text NOT NULL DEFAULT '', synced_at timestamptz NOT NULL DEFAULT now());
