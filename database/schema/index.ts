import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

export const userRoleEnum = pgEnum('user_role', ['admin', 'operator'])
export const forgeTypeEnum = pgEnum('forge_type', ['github', 'gitlab'])
export const healthStatusEnum = pgEnum('health_status', ['unknown', 'healthy', 'degraded', 'unhealthy'])
export const taskStatusEnum = pgEnum('task_status', [
  'queued',
  'starting',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
])
export const taskTypeEnum = pgEnum('task_type', [
  'github_issue',
  'gitlab_issue',
  'github_pr_implement',
  'gitlab_mr_implement',
  'github_pr_review',
  'gitlab_mr_review',
  'release',
])
export const controlActionEnum = pgEnum('control_action', ['reload_config', 'start', 'stop', 'restart'])
export const controlStatusEnum = pgEnum('control_status', [
  'pending',
  'acknowledged',
  'completed',
  'failed',
  'cancelled',
])
export const workerStatusEnum = pgEnum('worker_status', ['unknown', 'starting', 'running', 'stopping', 'stopped', 'error'])
export const connectionStatusEnum = pgEnum('connection_status', [
  'pending',
  'active',
  'error',
  'disconnected',
  'expired',
])
export const workspaceStatusEnum = pgEnum('workspace_status', [
  'not_cloned',
  'queued',
  'cloning',
  'ready',
  'syncing',
  'failed',
  'inaccessible',
])
export const workspaceOperationTypeEnum = pgEnum('workspace_operation_type', [
  'clone',
  'sync',
  'verify',
  'delete_workspace',
])
export const workspaceOperationStatusEnum = pgEnum('workspace_operation_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
])
export const promptKindEnum = pgEnum('prompt_kind', ['template', 'snippet'])

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  username: varchar('username', { length: 64 }).notNull(),
  passwordHash: text('password_hash').notNull(),
  role: userRoleEnum('role').notNull().default('admin'),
  isActive: boolean('is_active').notNull().default(true),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('users_username_uidx').on(t.username),
])

export const sessions = pgTable('sessions', {
  id: varchar('id', { length: 128 }).primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  ipHash: varchar('ip_hash', { length: 64 }),
  userAgent: varchar('user_agent', { length: 512 }),
}, (t) => [
  index('sessions_user_idx').on(t.userId),
  index('sessions_expires_idx').on(t.expiresAt),
])

export const forgeConnections = pgTable('forge_connections', {
  id: uuid('id').defaultRandom().primaryKey(),
  provider: forgeTypeEnum('provider').notNull(),
  displayName: varchar('display_name', { length: 128 }),
  instanceUrl: text('instance_url').notNull(),
  accountId: varchar('account_id', { length: 128 }).notNull(),
  accountLogin: varchar('account_login', { length: 256 }),
  accountName: varchar('account_name', { length: 256 }),
  scopes: text('scopes'),
  accessTokenCiphertext: text('access_token_ciphertext'),
  refreshTokenCiphertext: text('refresh_token_ciphertext'),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  status: connectionStatusEnum('status').notNull().default('pending'),
  lastError: text('last_error'),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('forge_connections_provider_instance_account_uidx').on(t.provider, t.instanceUrl, t.accountId),
  index('forge_connections_provider_idx').on(t.provider),
  index('forge_connections_status_idx').on(t.status),
])

export const oauthStates = pgTable('oauth_states', {
  state: varchar('state', { length: 128 }).primaryKey(),
  provider: forgeTypeEnum('provider').notNull(),
  instanceUrl: text('instance_url').notNull(),
  codeVerifier: text('code_verifier').notNull(),
  redirectPath: varchar('redirect_path', { length: 512 }).notNull().default('/connections'),
  createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').references(() => forgeConnections.id, { onDelete: 'cascade' }),
  displayName: varchar('display_name', { length: 128 }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('oauth_states_expires_idx').on(t.expiresAt),
])

export const discoveredRepositories = pgTable('discovered_repositories', {
  id: uuid('id').defaultRandom().primaryKey(),
  connectionId: uuid('connection_id').notNull().references(() => forgeConnections.id, { onDelete: 'cascade' }),
  providerRepoId: varchar('provider_repo_id', { length: 128 }).notNull(),
  fullName: varchar('full_name', { length: 512 }).notNull(),
  ownerLogin: varchar('owner_login', { length: 256 }).notNull(),
  name: varchar('name', { length: 256 }).notNull(),
  description: text('description'),
  visibility: varchar('visibility', { length: 32 }).notNull().default('private'),
  defaultBranch: varchar('default_branch', { length: 128 }).notNull().default('main'),
  cloneUrlHttps: text('clone_url_https').notNull(),
  htmlUrl: text('html_url'),
  permissions: jsonb('permissions').$type<Record<string, unknown>>().notNull().default({}),
  isArchived: boolean('is_archived').notNull().default(false),
  isFork: boolean('is_fork').notNull().default(false),
  lastDiscoveredAt: timestamp('last_discovered_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('discovered_repos_connection_provider_uidx').on(t.connectionId, t.providerRepoId),
  index('discovered_repos_full_name_idx').on(t.fullName),
  index('discovered_repos_connection_idx').on(t.connectionId),
])

export const repositories = pgTable('repositories', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 128 }).notNull(),
  forgeType: forgeTypeEnum('forge_type').notNull(),
  remoteUrl: text('remote_url').notNull(),
  canonicalProjectIdentifier: varchar('canonical_project_identifier', { length: 256 }),
  workspaceId: varchar('workspace_id', { length: 64 }).notNull(),
  localPath: text('local_path'),
  defaultBranch: varchar('default_branch', { length: 128 }).notNull().default('main'),
  isEnabled: boolean('is_enabled').notNull().default(false),
  isArchived: boolean('is_archived').notNull().default(false),
  blockOnOpenPr: boolean('block_on_open_pr').notNull().default(true),
  defaultAiProvider: varchar('default_ai_provider', { length: 32 }),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  connectionId: uuid('connection_id').references(() => forgeConnections.id, { onDelete: 'set null' }),
  discoveredRepositoryId: uuid('discovered_repository_id').references(() => discoveredRepositories.id, { onDelete: 'set null' }),
  providerRepoId: varchar('provider_repo_id', { length: 128 }),
  instanceUrl: text('instance_url'),
  visibility: varchar('visibility', { length: 32 }),
  workspaceStatus: workspaceStatusEnum('workspace_status').notNull().default('not_cloned'),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastCloneAt: timestamp('last_clone_at', { withTimezone: true }),
  lastError: text('last_error'),
  lastHealthCheckAt: timestamp('last_health_check_at', { withTimezone: true }),
  healthStatus: healthStatusEnum('health_status').notNull().default('unknown'),
  healthMessage: text('health_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('repositories_name_forge_uidx').on(t.name, t.forgeType),
  uniqueIndex('repositories_workspace_uidx').on(t.workspaceId),
  index('repositories_enabled_idx').on(t.isEnabled),
  index('repositories_forge_idx').on(t.forgeType),
  index('repositories_connection_idx').on(t.connectionId),
  index('repositories_workspace_status_idx').on(t.workspaceStatus),
  index('repositories_provider_identity_idx').on(t.forgeType, t.instanceUrl, t.providerRepoId),
])

export const workspaceOperations = pgTable('workspace_operations', {
  id: uuid('id').defaultRandom().primaryKey(),
  repositoryId: uuid('repository_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
  operationType: workspaceOperationTypeEnum('operation_type').notNull(),
  status: workspaceOperationStatusEnum('status').notNull().default('queued'),
  requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  errorSummary: text('error_summary'),
  logExcerpt: text('log_excerpt'),
  correlationId: varchar('correlation_id', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('workspace_operations_repo_idx').on(t.repositoryId),
  index('workspace_operations_status_idx').on(t.status),
  index('workspace_operations_created_idx').on(t.createdAt),
])

export const providerConfigs = pgTable('provider_configs', {
  id: uuid('id').defaultRandom().primaryKey(),
  providerType: varchar('provider_type', { length: 32 }).notNull(),
  displayName: varchar('display_name', { length: 128 }).notNull(),
  isEnabled: boolean('is_enabled').notNull().default(true),
  isDefault: boolean('is_default').notNull().default(false),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  secretCiphertext: text('secret_ciphertext'),
  lastHealthCheckAt: timestamp('last_health_check_at', { withTimezone: true }),
  healthStatus: healthStatusEnum('health_status').notNull().default('unknown'),
  healthMessage: text('health_message'),
  detectedVersion: varchar('detected_version', { length: 128 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('provider_configs_type_uidx').on(t.providerType),
])

export const settings = pgTable('settings', {
  key: varchar('key', { length: 128 }).primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
})

export const taskRuns = pgTable('task_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'set null' }),
  forgeType: forgeTypeEnum('forge_type').notNull(),
  taskType: taskTypeEnum('task_type').notNull(),
  externalId: varchar('external_id', { length: 64 }).notNull(),
  externalUrl: text('external_url'),
  title: text('title'),
  provider: varchar('provider', { length: 32 }),
  status: taskStatusEnum('status').notNull().default('queued'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  durationMs: integer('duration_ms'),
  exitCode: integer('exit_code'),
  errorSummary: text('error_summary'),
  resultMetadata: jsonb('result_metadata').$type<Record<string, unknown>>().notNull().default({}),
  logPath: text('log_path'),
  logExpired: boolean('log_expired').notNull().default(false),
  correlationId: varchar('correlation_id', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('task_runs_repo_idx').on(t.repositoryId),
  index('task_runs_status_idx').on(t.status),
  index('task_runs_started_idx').on(t.startedAt),
  index('task_runs_correlation_idx').on(t.correlationId),
  index('task_runs_external_idx').on(t.taskType, t.externalId),
])

export const workerEvents = pgTable('worker_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  eventType: varchar('event_type', { length: 64 }).notNull(),
  workerStatus: workerStatusEnum('worker_status'),
  message: text('message'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  configVersion: integer('config_version'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('worker_events_created_idx').on(t.createdAt),
  index('worker_events_type_idx').on(t.eventType),
])

export const workerState = pgTable('worker_state', {
  id: integer('id').primaryKey().default(1),
  status: workerStatusEnum('status').notNull().default('unknown'),
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
  lastPollAt: timestamp('last_poll_at', { withTimezone: true }),
  lastSuccessfulPollAt: timestamp('last_successful_poll_at', { withTimezone: true }),
  configVersionLoaded: integer('config_version_loaded'),
  hostname: varchar('hostname', { length: 256 }),
  pid: integer('pid'),
  version: varchar('version', { length: 64 }),
  providerAvailability: jsonb('provider_availability').$type<Record<string, unknown>>().notNull().default({}),
  activeTaskCount: integer('active_task_count').notNull().default(0),
  activeTasks: jsonb('active_tasks').$type<Array<{
    repositoryName?: string
    taskType?: string
    externalId?: string
    title?: string
    branch?: string
    pid?: number
    startedAt?: string
  }>>().notNull().default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const controlRequests = pgTable('control_requests', {
  id: uuid('id').defaultRandom().primaryKey(),
  action: controlActionEnum('action').notNull(),
  status: controlStatusEnum('status').notNull().default('pending'),
  requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  result: jsonb('result').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [
  index('control_requests_status_idx').on(t.status),
  index('control_requests_created_idx').on(t.createdAt),
])

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  actorUsername: varchar('actor_username', { length: 64 }),
  action: varchar('action', { length: 128 }).notNull(),
  targetType: varchar('target_type', { length: 64 }),
  targetId: varchar('target_id', { length: 128 }),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  ipHash: varchar('ip_hash', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('audit_logs_created_idx').on(t.createdAt),
  index('audit_logs_actor_idx').on(t.actorUserId),
  index('audit_logs_action_idx').on(t.action),
])

export const loginAttempts = pgTable('login_attempts', {
  id: uuid('id').defaultRandom().primaryKey(),
  username: varchar('username', { length: 64 }).notNull(),
  ipHash: varchar('ip_hash', { length: 64 }).notNull(),
  succeeded: boolean('succeeded').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('login_attempts_username_created_idx').on(t.username, t.createdAt),
  index('login_attempts_ip_created_idx').on(t.ipHash, t.createdAt),
])

/** Prompt templates/snippets seeded from worker/prompts/; editable in UI; fetched by worker per job. */
export const promptTemplates = pgTable('prompt_templates', {
  id: uuid('id').defaultRandom().primaryKey(),
  /** Relative path under prompts/, e.g. github-issue-implement.txt or snippets/minimal-changes.txt */
  path: varchar('path', { length: 256 }).notNull(),
  kind: promptKindEnum('kind').notNull(),
  taskType: taskTypeEnum('task_type'),
  displayName: varchar('display_name', { length: 128 }).notNull(),
  description: text('description'),
  content: text('content').notNull(),
  contentVersion: integer('content_version').notNull().default(1),
  seedChecksum: varchar('seed_checksum', { length: 64 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
}, (t) => [
  uniqueIndex('prompt_templates_path_uidx').on(t.path),
  index('prompt_templates_kind_idx').on(t.kind),
  index('prompt_templates_task_type_idx').on(t.taskType),
])
