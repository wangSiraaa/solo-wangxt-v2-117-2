'use strict';

const Fastify = require('fastify');
const websocket = require('@fastify/websocket');
const config = require('./config');
const db = require('./db');
const { wsConnection } = require('./ws');
const { getRoom } = require('./room');
const { compact, recoverFromStore } = require('./compaction');
const { createCheckpoint, listCheckpoints, getCheckpoint, validateName } = require('./checkpoints');
const { resolveToken, getActiveRole } = require('./permissions');
const yutil = require('./yutil');

// Shared guard for member-protected document endpoints: resolves the token,
// then re-checks (user, doc) membership and tenant alignment against the db.
// Sends the error response and returns null when access is denied.
async function requireMember(req, reply) {
  const token = req.headers['x-auth-token'];
  const session = await resolveToken(Array.isArray(token) ? token[0] : token);
  if (!session) {
    reply.code(401).send({ error: 'BAD_TOKEN' });
    return null;
  }
  const role = await getActiveRole(session.user_id, req.params.docId);
  if (!role || role.tenant_id !== session.tenant_id) {
    reply.code(403).send({ error: 'FORBIDDEN' });
    return null;
  }
  return { session, role };
}

async function buildServer() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });
  await app.register(websocket, {
    options: { maxPayload: 8 * 1024 * 1024 },
  });

  app.get('/healthz', async () => {
    const r = await db.query('SELECT 1 AS ok');
    return { ok: true, db: r.rows[0].ok === 1 };
  });

  // Administrative compaction trigger. Authenticated by user token; the
  // doc must belong to the same tenant and the user must be a writer/owner.
  app.post('/v1/docs/:docId/compact', async (req, reply) => {
    const token = req.headers['x-auth-token'];
    const session = await resolveToken(Array.isArray(token) ? token[0] : token);
    if (!session) return reply.code(401).send({ error: 'BAD_TOKEN' });
    const role = await getActiveRole(session.user_id, req.params.docId);
    if (!role || role.tenant_id !== session.tenant_id) {
      return reply.code(403).send({ error: 'FORBIDDEN' });
    }
    if (role.role === 'reader') return reply.code(403).send({ error: 'READ_ONLY' });

    const room = await getRoom(req.params.docId);
    const out = await compact(room, {
      deleteFolded: !!req.body?.deleteFolded,
      minUpdates: req.body?.minUpdates || 1,
    });
    return out;
  });

  // Recovery probe: rebuild the document purely from PostgreSQL
  // (latest snapshot + surviving tail), return the structural hash.
  app.get('/v1/docs/:docId/recovered-state', async (req, reply) => {
    const token = req.headers['x-auth-token'];
    const session = await resolveToken(Array.isArray(token) ? token[0] : token);
    if (!session) return reply.code(401).send({ error: 'BAD_TOKEN' });
    const role = await getActiveRole(session.user_id, req.params.docId);
    if (!role || role.tenant_id !== session.tenant_id) {
      return reply.code(403).send({ error: 'FORBIDDEN' });
    }
    const doc = await recoverFromStore(req.params.docId);
    const state = yutil.encodeState(doc);
    return {
      docId: req.params.docId,
      stateHash: yutil.sha256(state),
      stateLen: state.length,
      sv: yutil.decodeStateVector(yutil.stateVector(doc)),
      text: doc.getText('content').toString(),
    };
  });

  // Named teaching checkpoints. Create requires writer/owner (it mutates
  // doc-scoped metadata); list/read are open to any active member of the
  // doc's tenant, readers included. Capture happens inside the doc's serial
  // queue from the live consistent state; checkpoints are never rewritten by
  // later updates or compaction.
  app.post('/v1/docs/:docId/checkpoints', async (req, reply) => {
    const auth = await requireMember(req, reply);
    if (!auth) return;
    if (auth.role.role === 'reader') return reply.code(403).send({ error: 'READ_ONLY' });

    const check = validateName(req.body && req.body.name);
    if (!check.ok) return reply.code(400).send({ error: 'BAD_NAME', message: check.message });

    const room = await getRoom(req.params.docId);
    const out = await createCheckpoint(room, {
      name: check.name,
      userId: auth.session.user_id,
    });
    if (!out.ok) return reply.code(409).send({ error: out.code, message: out.message });
    return reply.code(201).send(out);
  });

  app.get('/v1/docs/:docId/checkpoints', async (req, reply) => {
    const auth = await requireMember(req, reply);
    if (!auth) return;
    return { docId: req.params.docId, checkpoints: await listCheckpoints(req.params.docId) };
  });

  app.get('/v1/docs/:docId/checkpoints/:name', async (req, reply) => {
    const auth = await requireMember(req, reply);
    if (!auth) return;
    const cp = await getCheckpoint(req.params.docId, req.params.name);
    if (!cp) return reply.code(404).send({ error: 'NOT_FOUND' });
    return cp;
  });

  app.register(async (instance) => {
    instance.get('/ws', { websocket: true }, (socket, req) => {
      wsConnection(socket, req);
    });
  });

  return app;
}

if (require.main === module) {
  buildServer().then(async (app) => {
    await app.listen({ host: config.http.host, port: config.http.port });
    app.log.info(`collab gateway listening on ws://${config.http.host}:${config.http.port}/ws`);

    const shutdown = async (signal) => {
      app.log.info(`received ${signal}, draining...`);
      try {
        await app.close();
        await db.close();
      } finally {
        process.exit(0);
      }
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }).catch((err) => {
    console.error('failed to start gateway:', err);
    process.exit(1);
  });
}

module.exports = { buildServer };
