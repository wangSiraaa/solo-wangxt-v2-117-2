-- Collaborative document gateway schema
-- PostgreSQL 15

CREATE TABLE IF NOT EXISTS tenants (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    title       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Permission is checked on EVERY connection and EVERY update; the room/doc
-- id is never trusted from the client without re-resolution against the db.
CREATE TABLE IF NOT EXISTS document_members (
    doc_id      TEXT NOT NULL REFERENCES documents(id),
    user_id     TEXT NOT NULL REFERENCES users(id),
    role        TEXT NOT NULL CHECK (role IN ('reader','writer','owner')),
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at  TIMESTAMPTZ,
    PRIMARY KEY (doc_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_members_user ON document_members(user_id);

-- Append-only Yjs update log.
--   (doc_id, seq)        canonical replay / catch-up order
--   (doc_id, client_msg_id)  idempotency for retries and duplicated frames
CREATE TABLE IF NOT EXISTS doc_updates (
    id              BIGINT GENERATED ALWAYS AS IDENTITY,
    doc_id          TEXT NOT NULL REFERENCES documents(id),
    seq             BIGINT NOT NULL,
    client_msg_id   TEXT NOT NULL,
    origin_user_id  TEXT NOT NULL,
    origin_sv_hash  TEXT,
    update_bytes    BYTEA NOT NULL,
    byte_len        INTEGER GENERATED ALWAYS AS (octet_length(update_bytes)) STORED,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    compressed_in   BIGINT,
    UNIQUE (doc_id, seq),
    UNIQUE (doc_id, client_msg_id)
);

CREATE INDEX IF NOT EXISTS idx_updates_doc_seq ON doc_updates(doc_id, seq);

-- Compacted snapshots. `state_hash` is sha256 of the Yjs full-state encoding,
-- used to prove snapshot+tail replay recovers exactly the same document.
CREATE TABLE IF NOT EXISTS doc_snapshots (
    id              BIGINT GENERATED ALWAYS AS IDENTITY,
    doc_id          TEXT NOT NULL REFERENCES documents(id),
    through_seq     BIGINT NOT NULL,          -- all updates seq <= this are folded in
    state_bytes     BYTEA NOT NULL,
    state_hash      TEXT NOT NULL,
    byte_len        INTEGER GENERATED ALWAYS AS (octet_length(state_bytes)) STORED,
    update_count    BIGINT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (doc_id, id)
);

-- Named teaching checkpoints. A checkpoint captures the FULL Yjs state of a
-- document at a specific seq, created inside the doc's serial queue from the
-- live (consistent) room state. Rows are immutable: later updates and log
-- compaction (including deleteFolded) never rewrite a checkpoint, so the
-- captured state/hash remain readable as long as the row exists.
CREATE TABLE IF NOT EXISTS doc_checkpoints (
    id              BIGINT GENERATED ALWAYS AS IDENTITY,
    doc_id          TEXT NOT NULL REFERENCES documents(id),
    name            TEXT NOT NULL,
    created_by      TEXT NOT NULL REFERENCES users(id),
    seq             BIGINT NOT NULL,          -- doc seq at capture time
    state_bytes     BYTEA NOT NULL,           -- full Yjs state at capture time
    state_hash      TEXT NOT NULL,            -- sha256 of state_bytes
    byte_len        INTEGER GENERATED ALWAYS AS (octet_length(state_bytes)) STORED,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (doc_id, name)
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_doc ON doc_checkpoints(doc_id, created_at);

-- Unknown / malformed / corrupt frames land here, with enough context to
-- locate the source (which connection/user/doc, raw payload, failure reason).
CREATE TABLE IF NOT EXISTS update_errors (
    id              BIGINT GENERATED ALWAYS AS IDENTITY,
    doc_id          TEXT,
    user_id         TEXT,
    tenant_id       TEXT,
    client_msg_id   TEXT,
    raw_len         INTEGER,
    raw_prefix_hex  TEXT,
    error_code      TEXT NOT NULL,
    error_message   TEXT NOT NULL,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_errors_doc ON update_errors(doc_id, received_at);
