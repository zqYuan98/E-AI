-- At most this many calls in flight to a provider at a time (null: no limit), against "concurrency limit exceeded" refusals.
ALTER TABLE model_providers ADD COLUMN IF NOT EXISTS max_concurrency integer;
