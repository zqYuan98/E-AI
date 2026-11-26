-- 招采申报（modules/tender）：一篇招采类资料认出来的要素，一篇一行。revision 是认的时候资料的版本，version 是规则的版本，
-- basis 是认的时候其余输入（原标题、标签、信源名）的摘要，任一变了就重新认；deadline_at 单独成列，列表按它排序。
-- 资料删了这一行跟着删。
CREATE TABLE tender_facts (
  article_id   text PRIMARY KEY REFERENCES articles (id) ON DELETE CASCADE,
  revision     integer NOT NULL,
  version      integer NOT NULL,
  basis        text NOT NULL,
  stage        text,
  region       text,
  deadline_at  timestamptz,
  facts        jsonb NOT NULL,
  extracted_at timestamptz NOT NULL DEFAULT now()
);
