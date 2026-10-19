CREATE TABLE access_sessions (
  id_hash text PRIMARY KEY,
  member_id integer NOT NULL REFERENCES access_members(id),
  credential_version integer NOT NULL,
  csrf_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
