-- 一条信息表消息列了哪些项目（opp_items.id），站内“信息表”页按它列出；其他消息为空数组。
ALTER TABLE opp_pushes ADD COLUMN items jsonb NOT NULL DEFAULT '[]';
