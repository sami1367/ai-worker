CREATE TABLE chat_work_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_session_id uuid REFERENCES project_chat_sessions(id) ON DELETE CASCADE,
  microservice_session_id uuid REFERENCES microservice_chat_sessions(id) ON DELETE CASCADE,
  mode varchar(16) NOT NULL DEFAULT 'chat' CHECK (mode IN ('chat', 'work')),
  revision integer NOT NULL DEFAULT 0,
  tasks jsonb NOT NULL DEFAULT '[]',
  repository_snapshot jsonb NOT NULL DEFAULT '[]',
  source_fingerprint text,
  generated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(project_session_id, microservice_session_id) = 1)
);
CREATE UNIQUE INDEX chat_work_states_project_uidx ON chat_work_states(project_session_id);
CREATE UNIQUE INDEX chat_work_states_microservice_uidx ON chat_work_states(microservice_session_id);
CREATE TABLE chat_work_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_id uuid NOT NULL REFERENCES chat_work_states(id) ON DELETE CASCADE,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  chat_url text NOT NULL,
  plan_revision integer NOT NULL,
  tasks jsonb NOT NULL,
  repository_snapshot jsonb NOT NULL,
  provider varchar(32) NOT NULL,
  codegraph_enabled boolean NOT NULL DEFAULT true,
  status varchar(32) NOT NULL DEFAULT 'queued',
  worker_id text,
  lease_token uuid,
  lease_expires_at timestamptz,
  agent_completed_at timestamptz,
  results jsonb NOT NULL DEFAULT '[]',
  error_summary text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX chat_work_runs_plan_uidx ON chat_work_runs(state_id, plan_revision);
CREATE UNIQUE INDEX chat_work_runs_active_uidx ON chat_work_runs(state_id) WHERE status IN ('queued', 'preparing', 'running', 'publishing');
CREATE INDEX chat_work_runs_owner_status_idx ON chat_work_runs(created_by_user_id, status);

-- Existing project chats use optimistic timestamp comparisons in JavaScript (millisecond precision).
ALTER TABLE project_chat_sessions ALTER COLUMN updated_at TYPE timestamptz(3) USING date_trunc('milliseconds', updated_at);
