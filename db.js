// db.js — Postgres persistence layer (Neon-compatible), same pattern as DispatchAI/RoastRadar.
//
// This is the shared data layer for the whole AI Agent Suite. Lead Qualifier, AI Sales,
// AI Voice, Customer Support, and Internal Workflow agents do NOT get their own tables —
// they all read/write through this schema via the CRM Agent's HTTP API. See
// ai-agent-suite/architecture.md for why.
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

if (!process.env.DATABASE_URL) {
  console.warn('WARNING: DATABASE_URL is not set. Set it to your Neon connection string.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
      ? { rejectUnauthorized: false }
      : false,
});

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

const db = {
  async all(sql, params = []) {
    const { rows } = await pool.query(toPg(sql), params);
    return rows;
  },
  async get(sql, params = []) {
    const { rows } = await pool.query(toPg(sql), params);
    return rows[0];
  },
  async run(sql, params = []) {
    const res = await pool.query(toPg(sql), params);
    return { rowCount: res.rowCount, rows: res.rows };
  },
};

function newId(prefix) {
  return `${prefix}_${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

function randomKey() {
  return (
    'key_' +
    Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('')
  );
}

// Creates tables if they don't exist, then seeds one demo tenant (with a login user,
// an API key for agent-to-agent calls, and a couple of sample records) on first run only.
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'owner',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, email)
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      company TEXT,
      source TEXT,
      status TEXT NOT NULL DEFAULT 'new', -- new | qualified | disqualified | customer
      lead_score INTEGER,
      lead_score_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS deals (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'new', -- new | contacted | qualified | proposal | won | lost
      value_cents INTEGER NOT NULL DEFAULT 0,
      owner TEXT, -- e.g. 'agent:sales' or a human name
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS interactions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
      agent TEXT NOT NULL, -- lead_qualifier | sales | voice | support | workflow | human
      channel TEXT NOT NULL, -- call | chat | email | ticket | system
      summary TEXT NOT NULL,
      raw JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS agent_actions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      agent TEXT NOT NULL,
      action TEXT NOT NULL, -- e.g. 'create_contact', 'update_deal_stage'
      target_type TEXT NOT NULL, -- contact | deal | interaction
      target_id TEXT,
      detail JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_contacts_tenant ON contacts(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_deals_tenant ON deals(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_interactions_tenant ON interactions(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_agent_actions_tenant ON agent_actions(tenant_id);
  `);

  const { c } = await db.get('SELECT COUNT(*)::int AS c FROM tenants');
  if (c === 0) await seedDemoTenant();
}

async function seedDemoTenant() {
  const tenantId = newId('t');
  const apiKey = randomKey();
  await db.run('INSERT INTO tenants (id, name, api_key) VALUES (?, ?, ?)', [
    tenantId,
    'Demo Co',
    apiKey,
  ]);

  const passwordHash = bcrypt.hashSync('demo1234', 10);
  await db.run(
    'INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
    [newId('u'), tenantId, 'demo@auberix.test', passwordHash, 'owner']
  );

  const c1 = newId('c');
  const c2 = newId('c');
  await db.run(
    'INSERT INTO contacts (id, tenant_id, name, email, company, source, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [c1, tenantId, 'Alex Rivera', 'alex@example.com', 'Rivera HVAC', 'website_form', 'new']
  );
  await db.run(
    'INSERT INTO contacts (id, tenant_id, name, email, company, source, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [c2, tenantId, 'Jamie Chen', 'jamie@example.com', 'Chen Consulting', 'referral', 'qualified']
  );

  await db.run(
    'INSERT INTO deals (id, tenant_id, contact_id, title, stage, value_cents, owner) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [newId('d'), tenantId, c2, 'Chen Consulting — annual plan', 'proposal', 480000, 'agent:sales']
  );

  await db.run(
    'INSERT INTO interactions (id, tenant_id, contact_id, agent, channel, summary) VALUES (?, ?, ?, ?, ?, ?)',
    [newId('i'), tenantId, c1, 'lead_qualifier', 'system', 'Initial inbound form submission scored.']
  );

  console.log('Seeded demo tenant. Login: demo@auberix.test / demo1234');
  console.log(`Demo tenant API key (for agent-to-agent calls): ${apiKey}`);
}

// Demo-mode helper: wipe and re-seed the demo tenant (cascades to all child rows).
// Only ever touches the tenant named 'Demo Co' — real tenants are untouched.
async function resetDemoTenant() {
  await db.run("DELETE FROM tenants WHERE name = 'Demo Co'");
  await seedDemoTenant();
}

module.exports = { db, pool, newId, randomKey, init, resetDemoTenant };
