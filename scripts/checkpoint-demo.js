#!/usr/bin/env node
'use strict';

// Checkpoint demo. A writer keeps editing over WebSocket while the doc owner
// pins a named teaching checkpoint through the member-guarded HTTP API:
//
//   1. edit #1 lands ("before checkpoint");
//   2. owner creates checkpoint -> captures (name, creator, seq, state, hash);
//   3. edit #2 lands ("after checkpoint") — the live document moves on;
//   4. reading the checkpoint still shows the OLD text and OLD hash, and the
//      stored bytes really hash to the stored hash;
//   5. compaction with deleteFolded physically removes the log rows the
//      checkpoint was captured from — the checkpoint is STILL readable and
//      unchanged, and the live document still recovers.
//
// Usage: npm run seed:reset && npm start   (in another terminal)
//        npm run demo:checkpoint

const http = require('node:http');
const crypto = require('node:crypto');
const { DocClient } = require('./lib-client');

const BASE = process.env.HTTP_URL || 'http://127.0.0.1:7777';
const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:7777/ws';
const DOC = process.env.DOC_ID || 'doc-demo';
const WRITER = process.env.TOKEN_WRITER || 'user-alice';
const OWNER = process.env.TOKEN_OWNER || 'user-owner';
const CP_NAME = process.env.CP_NAME || `lesson-${new Date().toISOString().slice(0, 19)}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function httpJson(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(`${BASE}${path}`, {
      method,
      headers: {
        'x-auth-token': token,
        ...(data
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
          : {}),
      },
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode, json, raw: b });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function main() {
  const writer = new DocClient({ url: WS_URL, token: WRITER, docId: DOC, name: 'writer', verbose: true });
  await writer.connect();
  console.log(`writer connected role=${writer.role} seq=${writer.seq}`);

  // -- edit #1: this is exactly the state the checkpoint will capture ------
  writer.localEdit((t) => t.insert(t.length, '[v1] 检查点之前的第一版内容。'));
  await writer.flush();
  await sleep(150);

  // -- owner pins the named checkpoint -------------------------------------
  const created = await httpJson('POST', `/v1/docs/${DOC}/checkpoints`, OWNER, { name: CP_NAME });
  if (created.status !== 200) throw new Error(`create checkpoint failed: ${created.raw}`);
  const cp = created.json;
  console.log(`\ncheckpoint created: id=${cp.id} name=${JSON.stringify(cp.name)}`);
  console.log(`  createdBy=${cp.createdBy} seq=${cp.seq}`);
  console.log(`  stateHash=${cp.stateHash}`);

  // -- edit #2: collaboration continues AFTER the checkpoint ---------------
  writer.localEdit((t) => t.insert(t.length, '[v2] 检查点之后的第二版内容。'));
  await writer.flush();
  await sleep(150);

  // -- read the checkpoint back: old content, old hash ----------------------
  const read1 = await httpJson('GET', `/v1/docs/${DOC}/checkpoints/${cp.id}`, OWNER);
  const c1 = read1.json;
  const live1 = (await httpJson('GET', `/v1/docs/${DOC}/recovered-state`, OWNER)).json;
  const hashOfStoredBytes = sha256(Buffer.from(c1.state, 'base64'));
  console.log('\nafter edit #2:');
  console.log(`  checkpoint text: ${JSON.stringify(c1.text)}`);
  console.log(`  checkpoint hash: ${c1.stateHash} (seq=${c1.seq})`);
  console.log(`  stored bytes re-hash matches: ${hashOfStoredBytes === c1.stateHash}`);
  console.log(`  live doc text:   ${JSON.stringify(live1.text)}`);
  console.log(`  live doc hash:   ${live1.stateHash}`);
  console.log(`  checkpoint kept old state while doc moved on: ${c1.stateHash !== live1.stateHash}`);

  // -- compact and physically delete the folded log rows --------------------
  const comp = await httpJson('POST', `/v1/docs/${DOC}/compact`, OWNER,
    { minUpdates: 1, deleteFolded: true });
  console.log(`\ncompaction: ${JSON.stringify(comp.json)}`);

  const read2 = await httpJson('GET', `/v1/docs/${DOC}/checkpoints/${cp.id}`, OWNER);
  const c2 = read2.json;
  const live2 = (await httpJson('GET', `/v1/docs/${DOC}/recovered-state`, OWNER)).json;
  console.log('after compaction + deleteFolded:');
  console.log(`  checkpoint still readable: ${read2.status === 200}`);
  console.log(`  checkpoint unchanged: ${c2.stateHash === c1.stateHash && c2.text === c1.text}`);
  console.log(`  checkpoint text: ${JSON.stringify(c2.text)}`);
  console.log(`  live doc still recovers: ${JSON.stringify(live2.text)}`);

  const list = await httpJson('GET', `/v1/docs/${DOC}/checkpoints`, OWNER);
  console.log(`\nall checkpoints of ${DOC}:`);
  for (const c of list.json.checkpoints) {
    console.log(`  #${c.id} ${JSON.stringify(c.name)} by ${c.createdBy} @seq${c.seq} hash=${c.stateHash.slice(0, 16)}…`);
  }

  writer.close();
  await sleep(100);
  process.exit(0);
}

main().catch((e) => { console.error('checkpoint demo failed:', e); process.exit(1); });
