-- The edit log: Misty's source of truth. Append-only; rows are never updated or deleted.
-- Only the log is migrated. The tasks projection is rebuilt from it (see projection.py).

CREATE TABLE task_edits (
    seq            INTEGER PRIMARY KEY AUTOINCREMENT,  -- global replay order
    edit_id        TEXT    NOT NULL UNIQUE,            -- UUIDv7
    type           TEXT    NOT NULL,                   -- e.g. 'task.created'
    type_version   INTEGER NOT NULL,                   -- payload shape version, for upcasters
    task_id        TEXT,                               -- primary affected task
    payload        TEXT    NOT NULL CHECK (json_valid(payload)),
    actor_kind     TEXT    NOT NULL,                   -- 'user' | 'agent' | 'system'
    actor_id       TEXT    NOT NULL,                   -- e.g. 'web:garden', 'agent:claude-code'
    correlation_id TEXT,                               -- groups edits from one agent turn or gesture
    reason         TEXT,                               -- why the edit was made, shown to the user
    reverts_seq    INTEGER REFERENCES task_edits (seq),
    occurred_at    TEXT    NOT NULL                    -- ISO-8601 UTC, fixed at command time
);

CREATE INDEX task_edits_task_id ON task_edits (task_id);
CREATE INDEX task_edits_correlation_id ON task_edits (correlation_id) WHERE correlation_id IS NOT NULL;

-- Every task an edit touches, so per-task history covers multi-task edits.
CREATE TABLE task_edit_targets (
    task_id TEXT    NOT NULL,
    seq     INTEGER NOT NULL REFERENCES task_edits (seq),
    PRIMARY KEY (task_id, seq)
) WITHOUT ROWID;

CREATE TRIGGER task_edits_no_update BEFORE UPDATE ON task_edits
BEGIN SELECT RAISE(ABORT, 'task_edits is append-only'); END;

CREATE TRIGGER task_edits_no_delete BEFORE DELETE ON task_edits
BEGIN SELECT RAISE(ABORT, 'task_edits is append-only'); END;

CREATE TRIGGER task_edit_targets_no_update BEFORE UPDATE ON task_edit_targets
BEGIN SELECT RAISE(ABORT, 'task_edit_targets is append-only'); END;

CREATE TRIGGER task_edit_targets_no_delete BEFORE DELETE ON task_edit_targets
BEGIN SELECT RAISE(ABORT, 'task_edit_targets is append-only'); END;
