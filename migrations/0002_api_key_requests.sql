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

CREATE INDEX IF NOT EXISTS idx_api_key_requests_requester_status ON api_key_requests(requester_user_id, status);
CREATE INDEX IF NOT EXISTS idx_api_key_requests_status_created ON api_key_requests(status, created_at DESC);
