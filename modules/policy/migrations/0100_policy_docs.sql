-- 政策规划库（modules/policy）：一份文件一行。字段都从原文核对过，核对不上的不存。
CREATE TABLE policy_docs (
  id                 serial PRIMARY KEY,
  doc_key            text NOT NULL UNIQUE,
  name               text NOT NULL,
  doc_type           text NOT NULL,
  level              text NOT NULL,
  issuers            text[] NOT NULL DEFAULT '{}',
  doc_no             text,
  issued_on          date,
  summary            text NOT NULL DEFAULT '',
  targets            jsonb NOT NULL DEFAULT '[]',
  tasks              jsonb NOT NULL DEFAULT '[]',
  ai_clauses         jsonb NOT NULL DEFAULT '[]',
  ai_relevance       text NOT NULL DEFAULT 'none',
  primary_article_id text NOT NULL,
  primary_role       text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
)
