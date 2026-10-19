-- 后台“政策库管理”登记的导入：一个网址（或一篇已有资料的重新抽取）一行，worker 逐条处理并记下结果。
CREATE TABLE policy_imports (
  id           serial PRIMARY KEY,
  url          text NOT NULL,
  article_id   text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'document', 'not_document', 'failed')),
  doc_id       integer,
  error        text,
  requested_by text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
