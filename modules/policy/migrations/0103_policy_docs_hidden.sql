-- 管理员隐藏的文件不出现在政策库里（抽取有误、与本站无关），数据保留，可以再显示。
ALTER TABLE policy_docs ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
