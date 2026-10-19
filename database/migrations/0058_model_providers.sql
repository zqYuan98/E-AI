CREATE TABLE model_providers (
  key text PRIMARY KEY CHECK (key ~ '^[a-z0-9][a-z0-9._-]{1,48}$'),
  label text NOT NULL,
  model text NOT NULL,
  base_url text NOT NULL,
  api_key_enc text NOT NULL,
  api_key_hint text NOT NULL,
  extra jsonb,
  reasoning_tokens integer,
  json_mode boolean NOT NULL DEFAULT true,
  vision boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
