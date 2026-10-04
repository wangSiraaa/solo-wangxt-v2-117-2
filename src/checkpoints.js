'use strict';

const Y = require('yjs');
const db = require('./db');
const yutil = require('./yutil');

// Named teaching checkpoints.
//
// A checkpoint is an immutable, named capture of a document's full Yjs state
// at the doc's current seq. Creation runs INSIDE the per-doc serial queue, so
// no update can interleave between reading the live state and freezing seq;
// the captured bytes are then verified against an independent store-only
// rebuild (snapshot + updates up to that seq) before the row is committed —
// the same "two independent construction paths" discipline as compaction.
//
// Nothing ever UPDATEs or DELETEs doc_checkpoints rows on the write/compaction
// path: normal updates append to doc_updates, compaction folds doc_updates into
// doc_snapshots, and both leave checkpoints untouched. There is intentionally
// no rollback/restore endpoint — a checkpoint is a read-only view of the past.

const NAME_MAX = 120;

function validateName(name) {
  if (typeof name !== 'string') return { ok: false, message: 'name must be a string' };
  const trimmed = name.trim();
  if (trimmed.length === 0) return { ok: false, message: 'name must not be empty' };
  if (trimmed.length > NAME_MAX) {
    return { ok: false, message: `name must be at most ${NAME_MAX} characters` };
  }
  return { ok: true, name: trimmed };
}

// Rebuild the document state as of `seq` using ONLY durable storage:
// latest snapshot with through_seq <= seq, plus logged updates up to seq.
async function rebuildFromStoreAtSeq(docId, seq) {
  const snapRes = await db.query(
    `SELECT state_bytes, through_seq FROM doc_snapshots
      WHERE doc_id = $1 AND through_seq <= $2
      ORDER BY id DESC LIMIT 1`,
    [docId, seq],
  );
  const snap = snapRes.rows[0] || null;
  const fromSeq = snap ? Number(snap.through_seq) : 0;
  const rowsRes = await db.query(
    `SELECT seq, update_bytes FROM doc_updates
      WHERE doc_id = $1 AND seq > $2 AND seq <= $3
      ORDER BY seq ASC`,
    [docId, fromSeq, seq],
  );
  return yutil.rebuild(snap ? snap.state_bytes : null, rowsRes.rows);
}

// Capture a checkpoint of the room's current state. Must be called with the
// doc's serial queue (room.enqueue) so the captured state and seq are a
// consistent cut w.r.t. the update stream.
async function createCheckpoint(room, { name, userId }) {
  return room.enqueue(async () => {
    const seq = room.loadedSeq;
    const stateBytes = yutil.encodeState(room.doc);
    const stateHash = yutil.sha256(stateBytes);

    // Consistency proof: the live in-memory state we are about to freeze must
    // equal a rebuild purely from PostgreSQL at the same seq. If this ever
    // failed, the checkpoint would freeze a state the log cannot reproduce.
    const replayed = await rebuildFromStoreAtSeq(room.docId, seq);
    const replayedBytes = yutil.encodeState(replayed);
    if (!replayedBytes.equals(stateBytes)) {
      throw new Error('checkpoint verification mismatch: live document != store replay at seq ' + seq);
    }

    try {
      const ins = await db.query(
        `INSERT INTO doc_checkpoints (doc_id, name, created_by, seq, state_bytes, state_hash)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, created_at`,
        [room.docId, name, userId, seq, stateBytes, stateHash],
      );
      return {
        ok: true,
        id: Number(ins.rows[0].id),
        docId: room.docId,
        name,
        createdBy: userId,
        seq,
        stateHash,
        byteLen: stateBytes.length,
        createdAt: ins.rows[0].created_at,
      };
    } catch (e) {
      if (e && e.code === '23505') { // unique_violation on (doc_id, name)
        return { ok: false, code: 'NAME_TAKEN', message: `checkpoint name already exists: ${name}` };
      }
      throw e;
    }
  });
}

async function listCheckpoints(docId) {
  const { rows } = await db.query(
    `SELECT id, name, created_by, seq, state_hash, byte_len, created_at
       FROM doc_checkpoints
      WHERE doc_id = $1
      ORDER BY id ASC`,
    [docId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    createdBy: r.created_by,
    seq: Number(r.seq),
    stateHash: r.state_hash,
    byteLen: Number(r.byte_len),
    createdAt: r.created_at,
  }));
}

// Full read of one checkpoint. The stored hash is re-verified on every read:
// a corrupted row surfaces as an error instead of silently wrong content.
async function getCheckpoint(docId, name) {
  const { rows } = await db.query(
    `SELECT id, name, created_by, seq, state_bytes, state_hash, created_at
       FROM doc_checkpoints
      WHERE doc_id = $1 AND name = $2`,
    [docId, name],
  );
  const row = rows[0];
  if (!row) return null;
  const stateBytes = Buffer.from(row.state_bytes);
  const actualHash = yutil.sha256(stateBytes);
  if (actualHash !== row.state_hash) {
    throw new Error(`checkpoint ${name} failed integrity check: stored hash ${row.state_hash} != ${actualHash}`);
  }
  const doc = yutil.createDoc();
  Y.applyUpdate(doc, new Uint8Array(stateBytes), 'checkpoint');
  return {
    id: Number(row.id),
    docId,
    name: row.name,
    createdBy: row.created_by,
    seq: Number(row.seq),
    stateHash: row.state_hash,
    byteLen: stateBytes.length,
    createdAt: row.created_at,
    sv: yutil.decodeStateVector(yutil.stateVector(doc)),
    text: doc.getText('content').toString(),
    state: stateBytes.toString('base64'),
  };
}

module.exports = { createCheckpoint, listCheckpoints, getCheckpoint, validateName, rebuildFromStoreAtSeq };
