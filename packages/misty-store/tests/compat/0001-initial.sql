BEGIN TRANSACTION;
CREATE TABLE projection_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO "projection_meta" VALUES('fingerprint','1bb019d93ec8eef2');
INSERT INTO "projection_meta" VALUES('last_applied_seq','14');
CREATE TABLE task_edit_targets (
    task_id TEXT    NOT NULL,
    seq     INTEGER NOT NULL REFERENCES task_edits (seq),
    PRIMARY KEY (task_id, seq)
) WITHOUT ROWID;
INSERT INTO "task_edit_targets" VALUES('00000000-0000-0000-0000-000000000001',1);
INSERT INTO "task_edit_targets" VALUES('00000000-0000-0000-0000-000000000001',6);
INSERT INTO "task_edit_targets" VALUES('00000000-0000-0000-0000-000000000001',14);
INSERT INTO "task_edit_targets" VALUES('00000000-0000-0000-0000-000000000065',2);
INSERT INTO "task_edit_targets" VALUES('00000000-0000-0000-0000-000000000065',5);
INSERT INTO "task_edit_targets" VALUES('00000000-0000-0000-0000-000000000065',7);
INSERT INTO "task_edit_targets" VALUES('00000000-0000-0000-0000-000000000065',8);
INSERT INTO "task_edit_targets" VALUES('00000000-0000-0000-0000-000000000065',9);
INSERT INTO "task_edit_targets" VALUES('00000000-0000-0000-0000-000000000065',10);
INSERT INTO "task_edit_targets" VALUES('00000000-0000-0000-0000-000000000065',13);
INSERT INTO "task_edit_targets" VALUES('00000000-0000-0000-0000-0000000000c9',3);
INSERT INTO "task_edit_targets" VALUES('00000000-0000-0000-0000-0000000000c9',11);
INSERT INTO "task_edit_targets" VALUES('00000000-0000-0000-0000-00000000012d',4);
INSERT INTO "task_edit_targets" VALUES('00000000-0000-0000-0000-00000000012d',12);
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
INSERT INTO "task_edits" VALUES(1,'00000000-0000-0000-0000-000000000002','task.created',1,'00000000-0000-0000-0000-000000000001','{"task_id": "00000000-0000-0000-0000-000000000001", "title": "Book dentist", "parent_id": null, "attrs": {"category": "admin", "section": "Health", "date": "2026-12-01", "date_kind": "due", "notes": "ask about the night guard"}}','user','web:dartboard','fixture',NULL,NULL,'2026-11-23T09:00:00Z');
INSERT INTO "task_edits" VALUES(2,'00000000-0000-0000-0000-000000000066','task.created',1,'00000000-0000-0000-0000-000000000065','{"task_id": "00000000-0000-0000-0000-000000000065", "title": "Find the number", "parent_id": "00000000-0000-0000-0000-000000000001", "attrs": {"quick": true, "x_energy": 2}}','agent','agent:claude-code','fixture',NULL,NULL,'2026-11-23T09:01:00Z');
INSERT INTO "task_edits" VALUES(3,'00000000-0000-0000-0000-0000000000ca','task.created',1,'00000000-0000-0000-0000-0000000000c9','{"task_id": "00000000-0000-0000-0000-0000000000c9", "title": "Thesis", "parent_id": null, "attrs": {"category": "uni"}}','user','web:dartboard','fixture',NULL,NULL,'2026-11-23T09:02:00Z');
INSERT INTO "task_edits" VALUES(4,'00000000-0000-0000-0000-00000000012e','task.created',1,'00000000-0000-0000-0000-00000000012d','{"task_id": "00000000-0000-0000-0000-00000000012d", "title": "captured by mistake", "parent_id": null, "attrs": {}}','user','web:dartboard','fixture',NULL,NULL,'2026-11-23T09:03:00Z');
INSERT INTO "task_edits" VALUES(5,'00000000-0000-0000-0000-000000000191','task.retitled',1,'00000000-0000-0000-0000-000000000065','{"task_id": "00000000-0000-0000-0000-000000000065", "before": "Find the number", "after": "Find the phone number"}','user','web:dartboard','fixture',NULL,NULL,'2026-11-23T09:04:00Z');
INSERT INTO "task_edits" VALUES(6,'00000000-0000-0000-0000-0000000001f5','task.attrs_set',1,'00000000-0000-0000-0000-000000000001','{"task_id": "00000000-0000-0000-0000-000000000001", "changes": {"date": {"before": "2026-12-01", "after": "2026-12-05"}, "date_kind": {"before": "due", "after": "scheduled"}}}','user','web:dartboard','fixture',NULL,NULL,'2026-11-23T09:05:00Z');
INSERT INTO "task_edits" VALUES(7,'00000000-0000-0000-0000-000000000259','task.attrs_unset',1,'00000000-0000-0000-0000-000000000065','{"task_id": "00000000-0000-0000-0000-000000000065", "removed": {"quick": true}}','user','web:dartboard','fixture',NULL,NULL,'2026-11-23T09:06:00Z');
INSERT INTO "task_edits" VALUES(8,'00000000-0000-0000-0000-0000000002bd','task.reparented',1,'00000000-0000-0000-0000-000000000065','{"task_id": "00000000-0000-0000-0000-000000000065", "before": "00000000-0000-0000-0000-000000000001", "after": "00000000-0000-0000-0000-0000000000c9"}','user','web:dartboard','fixture',NULL,NULL,'2026-11-23T09:07:00Z');
INSERT INTO "task_edits" VALUES(9,'00000000-0000-0000-0000-000000000321','task.completed',1,'00000000-0000-0000-0000-000000000065','{"task_id": "00000000-0000-0000-0000-000000000065", "before": "open"}','user','web:dartboard','fixture',NULL,NULL,'2026-11-23T09:08:00Z');
INSERT INTO "task_edits" VALUES(10,'00000000-0000-0000-0000-000000000385','task.reopened',1,'00000000-0000-0000-0000-000000000065','{"task_id": "00000000-0000-0000-0000-000000000065", "before": "done"}','user','web:dartboard','fixture',NULL,NULL,'2026-11-23T09:09:00Z');
INSERT INTO "task_edits" VALUES(11,'00000000-0000-0000-0000-0000000003e9','task.released',1,'00000000-0000-0000-0000-0000000000c9','{"task_id": "00000000-0000-0000-0000-0000000000c9", "before": "open"}','user','web:dartboard','fixture',NULL,NULL,'2026-11-23T09:10:00Z');
INSERT INTO "task_edits" VALUES(12,'00000000-0000-0000-0000-00000000044d','task.discarded',1,'00000000-0000-0000-0000-00000000012d','{"task_id": "00000000-0000-0000-0000-00000000012d", "before": "open"}','user','web:dartboard','fixture',NULL,NULL,'2026-11-23T09:11:00Z');
INSERT INTO "task_edits" VALUES(13,'00000000-0000-0000-0000-0000000004b1','edit.reverted',1,'00000000-0000-0000-0000-000000000065','{"reverted_seq": 5, "task_id": "00000000-0000-0000-0000-000000000065", "ops": [{"type": "task.retitled", "type_version": 1, "payload": {"task_id": "00000000-0000-0000-0000-000000000065", "before": "Find the phone number", "after": "Find the number"}}]}','user','web:dartboard','fixture',NULL,5,'2026-11-23T09:12:00Z');
INSERT INTO "task_edits" VALUES(14,'00000000-0000-0000-0000-000000000515','edit.reverted',1,'00000000-0000-0000-0000-000000000001','{"reverted_seq": 6, "task_id": "00000000-0000-0000-0000-000000000001", "ops": [{"type": "task.attrs_set", "type_version": 1, "payload": {"task_id": "00000000-0000-0000-0000-000000000001", "changes": {"date": {"before": "2026-12-05", "after": "2026-12-01"}, "date_kind": {"before": "scheduled", "after": "due"}}}}]}','agent','agent:claude-code','fixture',NULL,6,'2026-11-23T09:13:00Z');
CREATE TABLE tasks (
        id         TEXT    PRIMARY KEY,
        parent_id  TEXT    REFERENCES tasks (id),
        title      TEXT    NOT NULL,
        state      TEXT    NOT NULL,
        attrs      TEXT    NOT NULL CHECK (json_valid(attrs)),
        created_at TEXT    NOT NULL,
        updated_at TEXT    NOT NULL,
        version    INTEGER NOT NULL,
        last_seq   INTEGER NOT NULL
        -- Promote a hot attribute to an indexed column without touching the log, e.g.
        -- , dread INTEGER GENERATED ALWAYS AS (json_extract(attrs, '$.dread')) VIRTUAL
    );
INSERT INTO "tasks" VALUES('00000000-0000-0000-0000-000000000001',NULL,'Book dentist','open','{"category": "admin", "section": "Health", "date": "2026-12-01", "date_kind": "due", "notes": "ask about the night guard"}','2026-11-23T09:00:00Z','2026-11-23T09:13:00Z',3,14);
INSERT INTO "tasks" VALUES('00000000-0000-0000-0000-000000000065','00000000-0000-0000-0000-0000000000c9','Find the number','open','{"x_energy": 2}','2026-11-23T09:01:00Z','2026-11-23T09:12:00Z',7,13);
INSERT INTO "tasks" VALUES('00000000-0000-0000-0000-0000000000c9',NULL,'Thesis','released','{"category": "uni"}','2026-11-23T09:02:00Z','2026-11-23T09:10:00Z',2,11);
INSERT INTO "tasks" VALUES('00000000-0000-0000-0000-00000000012d',NULL,'captured by mistake','discarded','{}','2026-11-23T09:03:00Z','2026-11-23T09:11:00Z',2,12);
CREATE INDEX task_edits_task_id ON task_edits (task_id);
CREATE INDEX task_edits_correlation_id ON task_edits (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE TRIGGER task_edits_no_update BEFORE UPDATE ON task_edits
BEGIN SELECT RAISE(ABORT, 'task_edits is append-only'); END;
CREATE TRIGGER task_edits_no_delete BEFORE DELETE ON task_edits
BEGIN SELECT RAISE(ABORT, 'task_edits is append-only'); END;
CREATE TRIGGER task_edit_targets_no_update BEFORE UPDATE ON task_edit_targets
BEGIN SELECT RAISE(ABORT, 'task_edit_targets is append-only'); END;
CREATE TRIGGER task_edit_targets_no_delete BEFORE DELETE ON task_edit_targets
BEGIN SELECT RAISE(ABORT, 'task_edit_targets is append-only'); END;
CREATE INDEX tasks_parent_id ON tasks (parent_id);
CREATE INDEX tasks_state ON tasks (state);
DELETE FROM "sqlite_sequence";
INSERT INTO "sqlite_sequence" VALUES('task_edits',14);
COMMIT;
PRAGMA user_version = 1;
