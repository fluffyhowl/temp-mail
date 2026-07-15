PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS domains (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    is_verified INTEGER NOT NULL DEFAULT 0 CHECK (is_verified IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    disabled_at TEXT
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_algorithm TEXT NOT NULL DEFAULT 'PBKDF2-SHA256',
    password_iterations INTEGER NOT NULL DEFAULT 210000 CHECK (password_iterations >= 100000),
    password_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    disabled_at TEXT,
    deleted_at TEXT,
    last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    user_agent_hash TEXT,
    ip_hash TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS inboxes (
    id TEXT PRIMARY KEY,
    domain_id TEXT NOT NULL,
    owner_user_id TEXT,
    address TEXT NOT NULL UNIQUE COLLATE NOCASE,
    local_part TEXT NOT NULL COLLATE NOCASE,
    access_token_hash TEXT,
    access_token_prefix TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    disabled_at TEXT,
    deleted_at TEXT,
    last_message_at TEXT,
    FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE (domain_id, local_part)
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    inbox_id TEXT NOT NULL,
    provider_message_id TEXT,
    from_name TEXT,
    from_address TEXT,
    to_address TEXT NOT NULL,
    subject TEXT,
    text_body TEXT,
    html_body TEXT,
    raw_source TEXT,
    size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
    has_attachments INTEGER NOT NULL DEFAULT 0 CHECK (has_attachments IN (0, 1)),
    is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT,
    FOREIGN KEY (inbox_id) REFERENCES inboxes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    filename TEXT,
    content_type TEXT,
    size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
    storage_key TEXT,
    content_base64 TEXT,
    content_sha256 TEXT,
    content_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    created_by_user_id TEXT,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'disabled')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    expires_at TEXT,
    revoked_at TEXT,
    disabled_at TEXT,
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS api_key_requests (
    id TEXT PRIMARY KEY,
    requester_user_id TEXT NOT NULL,
    requested_scope TEXT NOT NULL CHECK (requested_scope IN ('inboxes:write')),
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'fulfilled')),
    rejection_reason TEXT,
    reviewed_by_user_id TEXT,
    reviewed_at TEXT,
    fulfilled_api_key_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (requester_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (reviewed_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (fulfilled_api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rate_limits (
    id TEXT PRIMARY KEY,
    bucket_key TEXT NOT NULL,
    subject_type TEXT NOT NULL CHECK (subject_type IN ('ip', 'user', 'api_key', 'inbox', 'global')),
    subject_hash TEXT NOT NULL,
    action TEXT NOT NULL,
    window_start TEXT NOT NULL,
    window_seconds INTEGER NOT NULL CHECK (window_seconds > 0),
    request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
    blocked_until TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (bucket_key, window_start)
);

CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    actor_user_id TEXT,
    actor_api_key_id TEXT,
    event_type TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    ip_hash TEXT,
    user_agent_hash TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (actor_api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_domains_status ON domains(status);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_role_status ON users(role, status);
CREATE INDEX IF NOT EXISTS idx_sessions_user_status ON sessions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_token_prefix ON sessions(token_prefix);
CREATE INDEX IF NOT EXISTS idx_inboxes_address_status ON inboxes(address, status);
CREATE INDEX IF NOT EXISTS idx_inboxes_owner_status ON inboxes(owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_inboxes_domain_local ON inboxes(domain_id, local_part);
CREATE INDEX IF NOT EXISTS idx_messages_inbox_received ON messages(inbox_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_cleanup ON messages(received_at, deleted_at);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_cleanup ON attachments(created_at, deleted_at);
CREATE INDEX IF NOT EXISTS idx_api_keys_owner_status ON api_keys(owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix_status ON api_keys(key_prefix, status);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_key_requests_requester_status ON api_key_requests(requester_user_id, status);
CREATE INDEX IF NOT EXISTS idx_api_key_requests_status_created ON api_key_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rate_limits_bucket_window ON rate_limits(bucket_key, window_start);
CREATE INDEX IF NOT EXISTS idx_rate_limits_subject_action ON rate_limits(subject_type, subject_hash, action);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor_created ON audit_events(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_type_created ON audit_events(event_type, created_at DESC);
