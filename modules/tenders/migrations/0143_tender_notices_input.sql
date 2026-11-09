-- 输入快照与抽取结果同版；seq 同时作为写入版本，旧行在下次 track 时补快照并重新排队。
ALTER TABLE tender_notices ADD COLUMN input jsonb;
