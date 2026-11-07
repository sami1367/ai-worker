CREATE TABLE microservice_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name varchar(100) NOT NULL,
  description text NOT NULL DEFAULT '',
  projects jsonb NOT NULL,
  codegraph_enabled boolean NOT NULL DEFAULT true,
  workspace_status varchar(32) NOT NULL DEFAULT 'queued',
  codegraph_status varchar(32) NOT NULL DEFAULT 'pending',
  last_error text,
  prepared_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX microservice_groups_owner_idx ON microservice_groups(created_by_user_id);
CREATE TABLE microservice_chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES microservice_groups(id) ON DELETE CASCADE,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New chat',
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX microservice_chat_sessions_group_owner_idx ON microservice_chat_sessions(group_id, created_by_user_id);
