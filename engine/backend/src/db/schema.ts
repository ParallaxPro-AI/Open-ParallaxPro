import type Database from 'better-sqlite3';

export function createSchema(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL DEFAULT 'Untitled Project',
            thumbnail TEXT,
            status TEXT NOT NULL DEFAULT 'draft',
            project_data TEXT,
            created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
            updated_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
        );

        CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);

        CREATE TABLE IF NOT EXISTS chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            chat_session_id TEXT,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            feedback TEXT,
            file_changes TEXT,
            project_data_snapshot TEXT,
            project_data_before TEXT,
            created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
        );

        CREATE INDEX IF NOT EXISTS idx_chat_project ON chat_messages(project_id, chat_session_id);
    `);

    // Migrations for existing databases
    const addColumn = (table: string, col: string, type: string) => {
        try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch {}
    };
    addColumn('chat_messages', 'feedback', 'TEXT');
    addColumn('chat_messages', 'file_changes', 'TEXT');
    addColumn('chat_messages', 'project_data_snapshot', 'TEXT');
    addColumn('chat_messages', 'project_data_before', 'TEXT');

    // Cloud sync: projects that also live on parallaxpro.ai are flagged
    // here so the editor can auto-push on save + surface sync status
    // in the project list. The project id is shared with prod (no
    // separate mapping column needed).
    addColumn('projects', 'is_cloud', 'INTEGER DEFAULT 0');
    addColumn('projects', 'cloud_user_id', 'INTEGER');
    addColumn('projects', 'cloud_pulled_updated_at', 'TEXT');
    addColumn('projects', 'edited_engine_hash', 'TEXT');

    // Background CREATE_GAME jobs: when non-null, the project is locked.
    // Other edits (chat, file save, replace-project-data) refuse until the
    // job settles. `generation_job_id` is the in-memory registry key; a DB
    // row with this column set but no matching registry entry means the
    // backend restarted mid-run and the job is orphaned (cleaned up on
    // startup). `generation_last_heartbeat_at` is bumped on every status
    // tick so the project list can flag silent jobs.
    addColumn('projects', 'generation_job_id', 'TEXT');
    addColumn('projects', 'generation_started_at', 'TEXT');
    addColumn('projects', 'generation_description', 'TEXT');
    addColumn('projects', 'generation_last_status', 'TEXT');
    addColumn('projects', 'generation_last_heartbeat_at', 'TEXT');
    addColumn('projects', 'generation_last_error', 'TEXT');
    // Timestamp stamped on a successful CREATE_GAME completion so the
    // project-list card can show a green "✓ Just built" strip until the
    // user opens the project (auto-cleared on GET /:id) or dismisses it
    // with the inline X. Nulled on every new generation start.
    addColumn('projects', 'generation_last_success_at', 'TEXT');
}
