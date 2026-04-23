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
    // The LLM's OFFER_CREATE_GAME tool surfaces a "Create from scratch"
    // button on the chat panel alongside its { } text. Previously the
    // button lived only as an in-memory flag on the WS client, which
    // vanished on refresh. Persisting the description per-message lets
    // the frontend re-render the button from chat history on reconnect.
    addColumn('chat_messages', 'offer_create_game_description', 'TEXT');

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

    // Absolute path to the per-run CLI session capture dir written by
    // session_capture.ts. Updated on every new run (points to the latest
    // capture). Admin-only — never exposed to user-facing routes.
    addColumn('projects', 'session_capture_path', 'TEXT');

    // Last chat session the user was on in this project. Written by
    // switch_chat_session / new_chat_session / first-message of a
    // freshly-minted session. The WS connect handler reads this to
    // restore the correct chat on refresh — "most recent by message
    // id" isn't enough because the user might have switched to an
    // older session without sending a new message.
    addColumn('projects', 'last_chat_session_id', 'TEXT');

    // LOAD_TEMPLATE counter. The first template load on a fresh project
    // is silent (the user just asked to make a game). The second and
    // later loads gate on a confirmation popup so the user can't lose
    // their current project to an agent-misread without one click.
    // See ai_chat_panel handleTemplateLoadConfirmRequired + the
    // confirm_template_load WS handler.
    addColumn('projects', 'load_template_count', 'INTEGER NOT NULL DEFAULT 0');

    // Agent-feedback pipeline — every completed CREATE_GAME (strict,
    // can't be dismissed) and every committed FIX_GAME (soft, dismissable)
    // writes a pending row here. On next WS connect the editor renders
    // a feedback form in the chat panel until the user rates it. Feeds
    // the AI's follow-up turn ("thanks" / "sorry, want me to fix it?")
    // and doubles as our training-data table.
    //
    // kind:         'create_game' | 'fix_game' — drives strict vs soft UX.
    // job_id:       CREATE_GAME generation_job_id, else NULL.
    // chat_message_id: for FIX_GAME, points at the assistant message that
    //                applied the change — lets the export reuse the
    //                snapshots already stored on chat_messages.
    // cli_session_path: copy of projects.session_capture_path at commit
    //                time, since that column is mutated on every new run.
    // prompt:       what the user actually asked for (user-facing phrasing,
    //                not the LLM-expanded brief).
    // project_before / project_after: JSON snapshots. CREATE_GAME always
    //                captures both inline (one-shot); FIX_GAME leaves them
    //                NULL and references chat_message_id instead.
    // rating:       'up' | 'down' | NULL (while pending).
    // feedback_text: free-form user text.
    // resolution:   'submitted' | 'dismissed' | NULL. Dismissal is soft —
    //                the next WS connect re-fires feedback_required until
    //                it's actually submitted. CREATE_GAME never dismisses.
    db.exec(`
        CREATE TABLE IF NOT EXISTS agent_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            job_id TEXT,
            chat_message_id INTEGER,
            cli_session_path TEXT,
            prompt TEXT,
            project_before TEXT,
            project_after TEXT,
            rating TEXT,
            feedback_text TEXT,
            resolution TEXT,
            created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
            resolved_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_agent_feedback_project ON agent_feedback(project_id, resolved_at);
        CREATE INDEX IF NOT EXISTS idx_agent_feedback_pending ON agent_feedback(project_id) WHERE resolved_at IS NULL;
    `);
}
