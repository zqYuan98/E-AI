-- 其他招采平台（信源里打了“招标”“招标计划”标签的）的来源名称；国网的两个平台为空，名称在代码里。
ALTER TABLE opp_notices ADD COLUMN source_name text NOT NULL DEFAULT '';
