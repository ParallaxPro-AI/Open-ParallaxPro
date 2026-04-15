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
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
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
            created_at TEXT DEFAULT (datetime('now'))
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
}
