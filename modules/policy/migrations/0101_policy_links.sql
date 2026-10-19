-- 每篇检查过的资料一行：它属于哪份文件（不是政策规划文件的 doc_id 为空），以什么身份（原文、解读、报道）。
CREATE TABLE policy_links (
  article_id  text PRIMARY KEY,
  doc_id      integer,
  role        text,
  outcome     text NOT NULL,
  attempts    integer NOT NULL DEFAULT 1,
  receipt_id  bigint,
  checked_at  timestamptz NOT NULL DEFAULT now()
)
