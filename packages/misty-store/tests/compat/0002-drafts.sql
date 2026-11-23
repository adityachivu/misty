BEGIN TRANSACTION;
CREATE TABLE drafts (
    id          TEXT    PRIMARY KEY,                 -- UUIDv7; also the applied edits' correlation_id
    client      TEXT    NOT NULL,                    -- who drafted it, e.g. 'web:dartboard'
    vocabulary  TEXT    NOT NULL,                    -- what the client's ops mean, for the translator
    note        TEXT,
    base_seq    INTEGER NOT NULL,                    -- head of the log when the draft started
    ops         TEXT    NOT NULL CHECK (json_valid(ops)),    -- client ops, in order
    after       TEXT    NOT NULL CHECK (json_valid(after)),  -- intended structure (misty_core.structure)
    status      TEXT    NOT NULL,                    -- open | applied | rejected | discarded
    settle_ms   INTEGER NOT NULL,                    -- apply after this long without changes
    hold_until  TEXT,                                -- client lease: don't settle before this
    translator  TEXT,                                -- who turned it into commands
    seqs        TEXT    CHECK (seqs IS NULL OR json_valid(seqs)),  -- edits it produced
    error       TEXT,                                -- why it was rejected
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);
INSERT INTO "drafts" VALUES('01a208a6-7465-755d-a123-bb164b1997e2','web:dartboard','Dartboard bubbles.',NULL,18,'[{"op": "merge", "dragged": "00000000-0000-0000-0000-000000000641", "target": "00000000-0000-0000-0000-0000000005dd", "group": "new:g1"}]','{"nodes":[{"id":"new:g1","parent":"00000000-0000-0000-0000-000000000579","title":"Book van + Buy tape","attrs":{}},{"id":"00000000-0000-0000-0000-0000000005dd","parent":"new:g1","title":null,"attrs":{}},{"id":"00000000-0000-0000-0000-000000000641","parent":"new:g1","title":null,"attrs":{}}],"removed":[]}','applied',6000,NULL,'standin:structure','[19, 20, 21]',NULL,'2026-11-23T12:00:00+00:00','2026-11-23T12:00:00+00:00');
INSERT INTO "drafts" VALUES('01a208a6-7466-7142-93f3-e00a1f0bd87d','web:dartboard','Dartboard bubbles.',NULL,21,'[{"op": "pop", "group": "00000000-0000-0000-0000-000000000579"}]','{"nodes":[],"removed":["00000000-0000-0000-0000-000000000579"]}','rejected',6000,NULL,'standin:structure',NULL,'Removing ''00000000-0000-0000-0000-000000000579'' would hide its subtasks [''00000000-0000-0000-0000-0000000006a5'', ''00000000-0000-0000-0000-000000000709'']; move them first','2026-11-23T12:00:00+00:00','2026-11-23T12:00:00+00:00');
INSERT INTO "drafts" VALUES('01a208a6-7466-7142-93f3-e00b5c545527','web:dartboard','Dartboard bubbles.',NULL,21,'[{"op": "to_root", "dragged": "00000000-0000-0000-0000-0000000006a5"}]','{"nodes":[{"id":"00000000-0000-0000-0000-0000000006a5","parent":null,"title":null,"attrs":{}}],"removed":[]}','discarded',6000,NULL,NULL,NULL,NULL,'2026-11-23T12:00:00+00:00','2026-11-23T12:00:00+00:00');
INSERT INTO "drafts" VALUES('01a208a6-7466-7142-93f3-e00c9c92f09d','web:dartboard','Dartboard bubbles.',NULL,21,'[{"op": "to_root"}]','{"nodes":[{"id":"00000000-0000-0000-0000-0000000006a5","parent":null,"title":null,"attrs":{"category":"admin"}}],"removed":[]}','open',6000,NULL,NULL,NULL,NULL,'2026-11-23T12:00:00+00:00','2026-11-23T12:00:00+00:00');
CREATE TABLE projection_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO "projection_meta" VALUES('fingerprint','1bb019d93ec8eef2');
INSERT INTO "projection_meta" VALUES('last_applied_seq','21');
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
INSERT INTO "task_edit_targets" VALUES('00000000-0000-0000-0000-000000000579',15);
INSERT INTO "task_edit_targets" VALUES('00000000-0000-0000-0000-0000000005dd',16);
INSERT INTO "task_edit_targets" VALUES('00000000-0000-0000-0000-0000000005dd',20);
INSERT INTO "task_edit_targets" VALUES('00000000-0000-0000-0000-000000000641',17);
INSERT INTO "task_edit_targets" VALUES('00000000-0000-0000-0000-000000000641',21);
INSERT INTO "task_edit_targets" VALUES('00000000-0000-0000-0000-0000000006a5',18);
INSERT INTO "task_edit_targets" VALUES('00000000-0000-0000-0000-000000000709',19);
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
INSERT INTO "task_edits" VALUES(15,'00000000-0000-0000-0000-00000000057a','task.created',1,'00000000-0000-0000-0000-000000000579','{"task_id": "00000000-0000-0000-0000-000000000579", "title": "Move flat", "parent_id": null, "attrs": {"category": "admin"}}','user','web:dartboard','fixture',NULL,NULL,'2026-11-23T09:14:00Z');
INSERT INTO "task_edits" VALUES(16,'00000000-0000-0000-0000-0000000005de','task.created',1,'00000000-0000-0000-0000-0000000005dd','{"task_id": "00000000-0000-0000-0000-0000000005dd", "title": "Book van", "parent_id": "00000000-0000-0000-0000-000000000579", "attrs": {}}','user','web:dartboard','fixture',NULL,NULL,'2026-11-23T09:15:00Z');
INSERT INTO "task_edits" VALUES(17,'00000000-0000-0000-0000-000000000642','task.created',1,'00000000-0000-0000-0000-000000000641','{"task_id": "00000000-0000-0000-0000-000000000641", "title": "Buy tape", "parent_id": "00000000-0000-0000-0000-000000000579", "attrs": {}}','user','web:dartboard','fixture',NULL,NULL,'2026-11-23T09:16:00Z');
INSERT INTO "task_edits" VALUES(18,'00000000-0000-0000-0000-0000000006a6','task.created',1,'00000000-0000-0000-0000-0000000006a5','{"task_id": "00000000-0000-0000-0000-0000000006a5", "title": "Pack boxes", "parent_id": "00000000-0000-0000-0000-000000000579", "attrs": {}}','user','web:dartboard','fixture',NULL,NULL,'2026-11-23T09:17:00Z');
INSERT INTO "task_edits" VALUES(19,'00000000-0000-0000-0000-00000000070a','task.created',1,'00000000-0000-0000-0000-000000000709','{"task_id": "00000000-0000-0000-0000-000000000709", "title": "Book van + Buy tape", "parent_id": "00000000-0000-0000-0000-000000000579", "attrs": {}}','user','web:dartboard','01a208a6-7465-755d-a123-bb164b1997e2','Reorganised in web:dartboard',NULL,'2026-11-23T09:18:00Z');
INSERT INTO "task_edits" VALUES(20,'00000000-0000-0000-0000-00000000076d','task.reparented',1,'00000000-0000-0000-0000-0000000005dd','{"task_id": "00000000-0000-0000-0000-0000000005dd", "before": "00000000-0000-0000-0000-000000000579", "after": "00000000-0000-0000-0000-000000000709"}','user','web:dartboard','01a208a6-7465-755d-a123-bb164b1997e2','Reorganised in web:dartboard',NULL,'2026-11-23T09:19:00Z');
INSERT INTO "task_edits" VALUES(21,'00000000-0000-0000-0000-0000000007d1','task.reparented',1,'00000000-0000-0000-0000-000000000641','{"task_id": "00000000-0000-0000-0000-000000000641", "before": "00000000-0000-0000-0000-000000000579", "after": "00000000-0000-0000-0000-000000000709"}','user','web:dartboard','01a208a6-7465-755d-a123-bb164b1997e2','Reorganised in web:dartboard',NULL,'2026-11-23T09:20:00Z');
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
INSERT INTO "tasks" VALUES('00000000-0000-0000-0000-000000000579',NULL,'Move flat','open','{"category": "admin"}','2026-11-23T09:14:00Z','2026-11-23T09:14:00Z',1,15);
INSERT INTO "tasks" VALUES('00000000-0000-0000-0000-0000000005dd','00000000-0000-0000-0000-000000000709','Book van','open','{}','2026-11-23T09:15:00Z','2026-11-23T09:19:00Z',2,20);
INSERT INTO "tasks" VALUES('00000000-0000-0000-0000-000000000641','00000000-0000-0000-0000-000000000709','Buy tape','open','{}','2026-11-23T09:16:00Z','2026-11-23T09:20:00Z',2,21);
INSERT INTO "tasks" VALUES('00000000-0000-0000-0000-0000000006a5','00000000-0000-0000-0000-000000000579','Pack boxes','open','{}','2026-11-23T09:17:00Z','2026-11-23T09:17:00Z',1,18);
INSERT INTO "tasks" VALUES('00000000-0000-0000-0000-000000000709','00000000-0000-0000-0000-000000000579','Book van + Buy tape','open','{}','2026-11-23T09:18:00Z','2026-11-23T09:18:00Z',1,19);
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
CREATE INDEX drafts_status ON drafts (status);
CREATE INDEX tasks_parent_id ON tasks (parent_id);
CREATE INDEX tasks_state ON tasks (state);
DELETE FROM "sqlite_sequence";
INSERT INTO "sqlite_sequence" VALUES('task_edits',21);
COMMIT;
PRAGMA user_version = 2;
