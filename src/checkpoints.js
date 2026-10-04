'use strict';

const db = require('./db');
const yutil = require('./yutil');

// Named checkpoints: immutable, member-created captures of a document's full
// Yjs state at a specific seq.
//
// Creation runs INSIDE the per-doc serial queue (room.enqueue), between two
// update jobs, so the captured (state, seq) pair is a consistent cut: every
// persisted update with seq <= room.loadedSeq is already applied to room.doc
// and no update can interleave while the state is encoded.
//
// Immutability is structural, not a convention: normal traffic only appends
// to doc_updates and mutates the live room doc; compaction only inserts into
// doc_snapshots and marks/deletes doc_updates rows. Neither path ever writes
// to doc_checkpoints, so a checkpoint keeps its original content and hash
// forever — even after the folded log rows it was captured from are deleted.

const NAME_MAX = 120;

function validateName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX) return null;
  return trimmed;
}

async function createCheckpoint(room, { name, createdBy }) {
  return room.enqueue(async () => {
    const stateBytes = yutil.encodeState(room.doc);
    const stateHash = yutil.sha256(stateBytes);
    const seq = room.loadedSeq;
    try {
      const ins = await db.query(
        `INSERT INTO doc_checkpoints (doc_id, name, created_by, seq, state_bytes, state_hash)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, created_at`,
        [room.docId, name, createdBy, seq, stateBytes, stateHash],
      );
      return {
        ok: true,
        checkpoint: {
          id: Number(ins.rows[0].id),
          docId: room.docId,
          name,
          createdBy,
          seq,
          stateHash,
          stateLen: stateBytes.length,
          createdAt: ins.rows[0].created_at,
        },
      };
    } catch (e) {
      // UNIQUE (doc_id, name): a name, once taken, is never rewritten.
      if (e && e.code === '23505') {
        return { ok: false, code: 'NAME_TAKEN', message: `checkpoint name already exists: ${name}` };
      }
      throw e;
    }
  });
}

async function listCheckpoints(docId) {
  const r = await db.query(
    `SELECT id, name, created_by, seq, state_hash, byte_len, created_at
       FROM doc_checkpoints
      WHERE doc_id = $1
      ORDER BY id ASC`,
    [docId],
  );
  return r.rows.map((row) => ({
    id: Number(row.id),
    docId,
    name: row.name,
    createdBy: row.created_by,
    seq: Number(row.seq),
    stateHash: row.state_hash,
    stateLen: Number(row.byte_len),
    createdAt: row.created_at,
  }));
}

async function getCheckpoint(docId, checkpointId) {
  const r = await db.query(
    `SELECT id, name, created_by, seq, state_bytes, state_hash, created_at
       FROM doc_checkpoints
      WHERE doc_id = $1 AND id = $2`,
    [docId, checkpointId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const stateBytes = Buffer.from(row.state_bytes);
  // Decode into a throwaway doc purely to render the text; the stored bytes
  // are the source of truth and are returned verbatim (base64).
  const doc = yutil.rebuild(row.state_bytes, []);
  return {
    id: Number(row.id),
    docId,
    name: row.name,
    createdBy: row.created_by,
    seq: Number(row.seq),
    stateHash: row.state_hash,
    stateLen: stateBytes.length,
    state: stateBytes.toString('base64'),
    text: doc.getText('content').toString(),
    createdAt: row.created_at,
  };
}

module.exports = { createCheckpoint, listCheckpoints, getCheckpoint, validateName };
