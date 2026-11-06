-- Reorganisation drafts (ADR 0003). Mutable working state, NOT part of the edit log:
-- a draft is discarded or applied, and applying it records ordinary edits whose
-- correlation_id is the draft id.

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

CREATE INDEX drafts_status ON drafts (status);
