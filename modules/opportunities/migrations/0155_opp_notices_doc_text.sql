-- Word 公告的正文（采集服务给的，最多 3 万字）：从里面抽通用资格、业绩和时间；附件里没有需求表时也按它判断。
ALTER TABLE opp_notices ADD COLUMN doc_text text NOT NULL DEFAULT '';
