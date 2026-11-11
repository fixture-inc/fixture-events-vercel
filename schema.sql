CREATE TABLE IF NOT EXISTS watches (
  id uuid PRIMARY KEY,
  scope text NOT NULL,
  name text NOT NULL,
  arguments jsonb NOT NULL,
  remote_id text UNIQUE,
  connector_id text,
  status text NOT NULL DEFAULT 'creating',
  cleanup_status text,
  stop_requested boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS receipts (
  delivery_id text PRIMARY KEY,
  scope text NOT NULL,
  subscription_id text NOT NULL REFERENCES watches(remote_id),
  digest text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  scope text NOT NULL,
  subscription_id text NOT NULL REFERENCES watches(remote_id),
  event_id text NOT NULL,
  name text NOT NULL,
  occurred_at timestamptz NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  data jsonb NOT NULL,
  redacted boolean NOT NULL DEFAULT false,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subscription_id, event_id)
);
CREATE INDEX IF NOT EXISTS events_subject ON events(scope, subject_type, subject_id);

CREATE TABLE IF NOT EXISTS tombstones (
  scope text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  PRIMARY KEY (scope, subject_type, subject_id)
);

CREATE TABLE IF NOT EXISTS controls (
  delivery_id text PRIMARY KEY REFERENCES receipts(delivery_id),
  scope text NOT NULL,
  subscription_id text NOT NULL,
  data jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
