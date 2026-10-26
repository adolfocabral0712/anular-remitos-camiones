CREATE TABLE IF NOT EXISTS solicitudes (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    matricula TEXT,
    ci TEXT,
    selected_id TEXT,
    candidates_json TEXT,
    message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    claimed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_solicitudes_status_created
ON solicitudes(status, created_at);
