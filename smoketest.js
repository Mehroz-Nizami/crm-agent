// smoketest.js — verifies db.js's actual SQL (schema + queries) against a real
// Postgres-compatible engine (pg-mem), and exercises server.js's routes end-to-end
// (auth, tenant scoping via session AND api key, CRUD, interactions, audit log, CSV export).
// Not part of the shipped app — dev/verification only, run with `node smoketest.js`.
const assert = require('assert');
const { newDb } = require('pg-mem');
const path = require('path');
const Module = require('module');

const mem = newDb({ autoCreateForeignKeyIndices: true });
mem.public.registerFunction({ name: 'now', returns: 'timestamp', implementation: () => new Date() });
const pgAdapter = mem.adapters.createPg();

// Intercept require('pg') so db.js picks up the in-memory adapter instead of a real network client.
const originalResolve = Module._resolveFilename;
const originalRequire = Module.prototype.require;
Module.prototype.require = function (request) {
  if (request === 'pg') return pgAdapter;
  return originalRequire.apply(this, arguments);
};

process.env.DATABASE_URL = 'postgresql://localhost/test';
process.env.SESSION_SECRET = 'test-secret';

async function main() {
  const { db } = require('./db');
  const request = require('supertest');

  // server.js's start() calls init() itself, then app.listen — capture the app before
  // listen actually binds a port by patching it. Only ONE call to init() happens this way
  // (calling it twice tripped a pg-mem limitation on re-running "CREATE TABLE IF NOT EXISTS"
  // — a pg-mem parsing quirk, not a real Postgres issue, but easiest to just not double-call it).
  const express = require('express');
  const originalListen = express.application.listen;
  let capturedApp = null;
  express.application.listen = function (...args) {
    capturedApp = this;
    return { close() {} }; // fake server, don't actually bind a port
  };

  require('./server.js');
  // Poll until start() finishes (richer seed data takes >300ms through pg-mem).
  for (let i = 0; i < 100 && !capturedApp; i++) await new Promise((r) => setTimeout(r, 100));
  express.application.listen = originalListen;
  assert(capturedApp, 'server app should have been captured');
  const app = capturedApp;

  console.log('✓ schema created + demo tenant seeded (via server startup)');
  const tenant = await db.get('SELECT * FROM tenants LIMIT 1');
  assert(tenant.api_key.startsWith('key_'));
  console.log('✓ demo tenant + api key present:', tenant.api_key.slice(0, 10) + '...');

  const agent = request.agent(app); // keeps cookies across calls, like a browser session

  // 1. Reject unauthenticated access
  let res = await agent.get('/api/contacts');
  assert.strictEqual(res.status, 401);
  console.log('✓ unauthenticated request correctly rejected');

  // 2. Wrong password rejected
  res = await agent.post('/api/login').send({ email: 'demo@auberix.test', password: 'wrong' });
  assert.strictEqual(res.status, 401);

  // 3. Correct login
  res = await agent.post('/api/login').send({ email: 'demo@auberix.test', password: 'demo1234' });
  assert.strictEqual(res.status, 200);
  console.log('✓ session login works, wrong password rejected first');

  // 4. Seeded data visible via session
  res = await agent.get('/api/contacts');
  assert.strictEqual(res.status, 200);
  const { CONTACTS } = require('./seed-data');
  assert.strictEqual(res.body.length, CONTACTS.length);
  console.log('✓ session-scoped GET /api/contacts returns seeded rows');

  // 5. Create a contact via session (human path — should NOT hit agent_actions)
  res = await agent.get('/api/agent-actions');
  const auditBaseline = res.body.length; // seed data ships with audit history

  res = await agent.post('/api/contacts').send({ name: 'Human-added Contact', source: 'manual' });
  assert.strictEqual(res.status, 200);
  const humanContactId = res.body.id;

  res = await agent.get('/api/agent-actions');
  assert.strictEqual(res.body.length, auditBaseline, 'human session writes should not appear in agent_actions');
  console.log('✓ human session write correctly excluded from agent_actions audit log');

  // 6. Same write via API key (agent path) — SHOULD hit agent_actions
  res = await request(app)
    .post('/api/contacts')
    .set('x-api-key', tenant.api_key)
    .set('x-agent-name', 'lead_qualifier')
    .send({ name: 'Agent-added Contact', source: 'inbound_call' });
  assert.strictEqual(res.status, 200);
  const agentContactId = res.body.id;

  res = await request(app).get('/api/agent-actions').set('x-api-key', tenant.api_key);
  assert.strictEqual(res.body.length, auditBaseline + 1);
  assert.strictEqual(res.body[0].agent, 'lead_qualifier');
  assert.strictEqual(res.body[0].action, 'create_contact');
  console.log('✓ agent (API key) write correctly logged to agent_actions with agent name attributed');

  // 7. Cross-tenant isolation: second tenant can't see first tenant's data
  const { newId } = require('./db');
  const bcrypt = require('bcryptjs');
  const tenant2Id = newId('t');
  await db.run('INSERT INTO tenants (id, name, api_key) VALUES (?, ?, ?)', [tenant2Id, 'Other Co', 'key_other_tenant_test']);
  await db.run('INSERT INTO users (id, tenant_id, email, password_hash) VALUES (?, ?, ?, ?)', [
    newId('u'), tenant2Id, 'owner@otherco.test', bcrypt.hashSync('pw', 10),
  ]);
  res = await request(app).get('/api/contacts').set('x-api-key', 'key_other_tenant_test');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.length, 0, 'tenant 2 must not see tenant 1 contacts');
  console.log('✓ cross-tenant isolation holds (new tenant sees zero contacts, not tenant 1\'s data)');

  // 8. Interaction logging + deal creation via API key
  res = await request(app)
    .post('/api/interactions')
    .set('x-api-key', tenant.api_key)
    .set('x-agent-name', 'voice')
    .send({ contact_id: agentContactId, agent: 'voice', channel: 'call', summary: 'Inbound call, interested in pricing.' });
  assert.strictEqual(res.status, 200);

  res = await request(app)
    .post('/api/deals')
    .set('x-api-key', tenant.api_key)
    .set('x-agent-name', 'sales')
    .send({ contact_id: agentContactId, title: 'New deal from voice lead', stage: 'contacted', value_cents: 250000 });
  assert.strictEqual(res.status, 200);
  console.log('✓ interaction + deal creation via agent API key works, contact linkage intact');

  // 9. CSV export requires session, rejects API key
  res = await request(app).get('/api/export/contacts.csv').set('x-api-key', tenant.api_key);
  assert.strictEqual(res.status, 401, 'CSV export must require a human session, not an API key');
  res = await agent.get('/api/export/contacts.csv');
  assert.strictEqual(res.status, 200);
  assert(res.text.includes('Human-added Contact'));
  console.log('✓ CSV export requires session (API key rejected), and produces expected rows');

  // 10. Logout invalidates session
  res = await agent.post('/api/logout');
  assert.strictEqual(res.status, 200);
  res = await agent.get('/api/contacts');
  assert.strictEqual(res.status, 401);
  console.log('✓ logout correctly invalidates session');

  console.log('\nALL SMOKE TESTS PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
