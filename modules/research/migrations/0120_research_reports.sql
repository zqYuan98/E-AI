-- 研报库（modules/research）：一份研报一行。只存标题、机构、日期、摘要、带原话的要点和原文链接；不存 PDF 和全文。
CREATE TABLE research_reports (
  id           serial PRIMARY KEY,
  dj_id        text UNIQUE,
  url          text NOT NULL UNIQUE,
  title        text NOT NULL,
  institution  text NOT NULL DEFAULT '',
  published_on date,
  summary      text NOT NULL DEFAULT '',
  points       jsonb NOT NULL DEFAULT '[]',
  topics       text[] NOT NULL DEFAULT '{}',
  hidden       boolean NOT NULL DEFAULT false,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
