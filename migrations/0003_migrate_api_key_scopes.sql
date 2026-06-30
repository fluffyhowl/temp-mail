UPDATE api_keys
SET scopes = '["inboxes:write"]',
    updated_at = datetime('now')
WHERE scopes LIKE '%inboxes:*%';

UPDATE api_key_requests
SET requested_scope = 'inboxes:write',
    updated_at = datetime('now')
WHERE requested_scope = 'inboxes:*';
