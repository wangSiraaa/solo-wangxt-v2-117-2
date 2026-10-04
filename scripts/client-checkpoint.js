#!/usr/bin/env node
'use strict';

// Checkpoint demo: a doc owner leaves a NAMED teaching checkpoint between two
// edits, then proves the checkpoint keeps showing the OLD content and hash
// while the live document moves on — even after log compaction physically
// deletes the folded updates. Also shows the permission boundary (a
// cross-tenant user cannot read the checkpoint).
//
// Run: npm start  (in one terminal)
//      npm run demo:checkpoint

const { DocClient } = require('./lib-client');

const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:7777/ws';
const BASE = process.env.HTTP_URL || 'http://127.0.0.1:7777';
const DOC = process.env.DOC_ID || 'doc-demo';
const OWNER = process.env.TOKEN_OWNER || 'user-owner';

async function api(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-auth-token': token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  const cpName = `lesson-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  const owner = new DocClient({ url: WS_URL, token: OWNER, docId: DOC, name: 'owner', verbose: true });
  await owner.connect();
  console.log('owner connected, role=', owner.role, 'seq=', owner.seq);

  // --- edit #1: the content the checkpoint will freeze ---------------------
  owner.localEdit((t) => t.insert(t.length, `[${cpName}] 第 1 课：检查点之前的内容。\n`));
  await owner.flush();
  console.log('\n== edit #1 flushed ==');
  console.log('live text:', JSON.stringify(owner.text));
  console.log('live hash:', owner.stateHash());

  // --- create the named checkpoint (HTTP, member-guarded) ------------------
  const created = await api('POST', `/v1/docs/${DOC}/checkpoints`, OWNER, { name: cpName });
  if (created.status !== 201) throw new Error(`checkpoint create failed: ${JSON.stringify(created)}`);
  console.log(`\n== checkpoint "${cpName}" created ==`);
  console.log('seq:', created.body.seq, ' hash:', created.body.stateHash);

  // --- edit #2: the live document moves on ---------------------------------
  owner.localEdit((t) => t.insert(t.length, `[${cpName}] 第 2 课：检查点之后的新内容。\n`));
  await owner.flush();
  await new Promise((r) => setTimeout(r, 150));
  console.log('\n== edit #2 flushed (live doc moved on) ==');
  console.log('live hash:', owner.stateHash());

  // --- read the checkpoint back: old content, old hash ---------------------
  const cp1 = await api('GET', `/v1/docs/${DOC}/checkpoints/${encodeURIComponent(cpName)}`, OWNER);
  console.log('\n== checkpoint read after edit #2 ==');
  console.log('checkpoint seq :', cp1.body.seq);
  console.log('checkpoint hash:', cp1.body.stateHash);
  console.log('checkpoint text:', JSON.stringify(cp1.body.text));
  console.log('hash unchanged :', cp1.body.stateHash === created.body.stateHash);
  console.log('frozen before edit #2:', !cp1.body.text.includes('第 2 课'));

  // --- compact with physical deletion of the folded log --------------------
  const compact = await api('POST', `/v1/docs/${DOC}/compact`, OWNER,
    { minUpdates: 1, deleteFolded: true });
  console.log('\n== compacted (deleteFolded=true) ==');
  console.log(compact.body);

  const cp2 = await api('GET', `/v1/docs/${DOC}/checkpoints/${encodeURIComponent(cpName)}`, OWNER);
  console.log('== checkpoint read after compaction ==');
  console.log('checkpoint hash:', cp2.body.stateHash,
    '(unchanged:', cp2.body.stateHash === created.body.stateHash, ')');
  console.log('checkpoint text:', JSON.stringify(cp2.body.text));

  // --- list + permission boundary ------------------------------------------
  const list = await api('GET', `/v1/docs/${DOC}/checkpoints`, OWNER);
  console.log('\n== checkpoint list ==');
  for (const c of list.body.checkpoints) {
    console.log(` - ${c.name}  seq=${c.seq}  by=${c.createdBy}  hash=${c.stateHash.slice(0, 12)}…`);
  }

  const dave = await api('GET', `/v1/docs/${DOC}/checkpoints/${encodeURIComponent(cpName)}`, 'user-dave');
  console.log('\ncross-tenant read (user-dave) ->', dave.status, JSON.stringify(dave.body));

  owner.close();
  await new Promise((r) => setTimeout(r, 100));
  process.exit(0);
}

main().catch((e) => { console.error('checkpoint demo failed:', e); process.exit(1); });
