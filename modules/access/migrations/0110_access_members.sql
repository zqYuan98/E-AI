CREATE TABLE access_members (
  id serial PRIMARY KEY,
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  display_name text NOT NULL,
  password_hash text NOT NULL,
  credential_version integer NOT NULL DEFAULT 1,
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
