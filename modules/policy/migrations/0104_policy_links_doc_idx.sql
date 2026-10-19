-- 一份文件的原文、解读和报道（详情页、删除和重新抽取都按 doc_id 找）。
CREATE INDEX CONCURRENTLY IF NOT EXISTS policy_links_doc_idx ON policy_links (doc_id) WHERE doc_id IS NOT NULL;
