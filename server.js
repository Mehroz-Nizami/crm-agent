const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const { db, newId, init, resetDemoTenant } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const DEMO_MODE = process.env.DEMO_MODE === 'true';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-in-production';

app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 8 }, // 8-hour session
  })
);

const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---- Demo mode (portfolio deployments only) ----
// Every visitor is transparently logged in to the seeded demo tenant, and demo
// data is re-seeded on boot and on an interval. Product deployments leave
// DEMO_MODE unset and get normal multi-tenant auth.
if (DEMO_MODE) {
  app.use(ah(async (req, res, next) => {
    if (!(req.session && req.session.tenantId)) {
      const u = await db.get("SELECT id, tenant_id FROM users WHERE email = 'demo@auberix.test'");
      if (u) {
        req.session.userId = u.id;
        req.session.tenantId = u.tenant_id;
      }
    }
    next();
  }));
}

// ---- Tenant resolution ----
// Two ways to authenticate against this API, on purpose:
//   1. Session cookie (human dashboard user) — set by /api/login.
//   2. `x-api-key` header (the other 5 agents calling in) — paired with `x-agent-name`
//      so every write can be attributed to the agent that made it in agent_actions.
// Both resolve to the same req.tenantId so every downstream query is tenant-scoped either way.
async function resolveTenant(req, res, next) {
  if (req.session && req.session.tenantId) {
    req.tenantId = req.session.tenantId;
    req.actor = { type: 'human', id: req.session.userId };
    return next();
  }
  const apiKey = req.header('x-api-key');
  if (apiKey) {
    const tenant = await db.get('SELECT * FROM tenants WHERE api_key = ?', [apiKey]);
    if (!tenant) return res.status(401).json({ error: 'Invalid API key' });
    req.tenantId = tenant.id;
    req.actor = { type: 'agent', id: req.header('x-agent-name') || 'unknown_agent' };
    return next();
  }
  return res.status(401).json({ error: 'Not authenticated (no session or x-api-key)' });
}

async function logAction(req, action, targetType, targetId, detail) {
  if (req.actor.type !== 'agent') return; // audit log tracks agent activity, not every human click
  await db.run(
    'INSERT INTO agent_actions (id, tenant_id, agent, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [newId('a'), req.tenantId, req.actor.id, action, targetType, targetId, JSON.stringify(detail || {})]
  );
}

// ---- Auth routes (human dashboard) ----
app.post('/api/login', ah(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  req.session.userId = user.id;
  req.session.tenantId = user.tenant_id;
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ authed: !!(req.session && req.session.tenantId) });
});

// ---- Contacts ----
app.get('/api/contacts', resolveTenant, ah(async (req, res) => {
  res.json(await db.all('SELECT * FROM contacts WHERE tenant_id = ? ORDER BY created_at DESC', [req.tenantId]));
}));

app.post('/api/contacts', resolveTenant, ah(async (req, res) => {
  const { name, email, phone, company, source, status } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = newId('c');
  await db.run(
    'INSERT INTO contacts (id, tenant_id, name, email, phone, company, source, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, req.tenantId, name, email || null, phone || null, company || null, source || null, status || 'new']
  );
  await logAction(req, 'create_contact', 'contact', id, { name, source });
  res.json(await db.get('SELECT * FROM contacts WHERE id = ? AND tenant_id = ?', [id, req.tenantId]));
}));

app.patch('/api/contacts/:id', resolveTenant, ah(async (req, res) => {
  const contact = await db.get('SELECT * FROM contacts WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  const { name, email, phone, company, source, status, lead_score, lead_score_reason } = req.body || {};
  await db.run(
    `UPDATE contacts SET name=?, email=?, phone=?, company=?, source=?, status=?, lead_score=?, lead_score_reason=?, updated_at=now()
     WHERE id=? AND tenant_id=?`,
    [
      name ?? contact.name,
      email ?? contact.email,
      phone ?? contact.phone,
      company ?? contact.company,
      source ?? contact.source,
      status ?? contact.status,
      lead_score ?? contact.lead_score,
      lead_score_reason ?? contact.lead_score_reason,
      req.params.id,
      req.tenantId,
    ]
  );
  await logAction(req, 'update_contact', 'contact', req.params.id, req.body);
  res.json(await db.get('SELECT * FROM contacts WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]));
}));

// ---- Deals ----
app.get('/api/deals', resolveTenant, ah(async (req, res) => {
  res.json(await db.all('SELECT * FROM deals WHERE tenant_id = ? ORDER BY created_at DESC', [req.tenantId]));
}));

app.post('/api/deals', resolveTenant, ah(async (req, res) => {
  const { contact_id, title, stage, value_cents, owner } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title is required' });
  const id = newId('d');
  await db.run(
    'INSERT INTO deals (id, tenant_id, contact_id, title, stage, value_cents, owner) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, req.tenantId, contact_id || null, title, stage || 'new', value_cents || 0, owner || null]
  );
  await logAction(req, 'create_deal', 'deal', id, { title, stage });
  res.json(await db.get('SELECT * FROM deals WHERE id = ? AND tenant_id = ?', [id, req.tenantId]));
}));

app.patch('/api/deals/:id', resolveTenant, ah(async (req, res) => {
  const deal = await db.get('SELECT * FROM deals WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });
  const { title, stage, value_cents, owner } = req.body || {};
  await db.run(
    'UPDATE deals SET title=?, stage=?, value_cents=?, owner=?, updated_at=now() WHERE id=? AND tenant_id=?',
    [title ?? deal.title, stage ?? deal.stage, value_cents ?? deal.value_cents, owner ?? deal.owner, req.params.id, req.tenantId]
  );
  await logAction(req, 'update_deal', 'deal', req.params.id, req.body);
  res.json(await db.get('SELECT * FROM deals WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]));
}));

// ---- Interactions (every agent logs its touches here) ----
app.get('/api/interactions', resolveTenant, ah(async (req, res) => {
  const { contact_id } = req.query;
  if (contact_id) {
    return res.json(
      await db.all('SELECT * FROM interactions WHERE tenant_id = ? AND contact_id = ? ORDER BY created_at DESC', [req.tenantId, contact_id])
    );
  }
  res.json(await db.all('SELECT * FROM interactions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200', [req.tenantId]));
}));

app.post('/api/interactions', resolveTenant, ah(async (req, res) => {
  const { contact_id, agent, channel, summary, raw } = req.body || {};
  if (!agent || !channel || !summary) return res.status(400).json({ error: 'agent, channel, and summary are required' });
  const id = newId('i');
  await db.run(
    'INSERT INTO interactions (id, tenant_id, contact_id, agent, channel, summary, raw) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, req.tenantId, contact_id || null, agent, channel, summary, raw ? JSON.stringify(raw) : null]
  );
  if (contact_id) await db.run('UPDATE contacts SET updated_at = now() WHERE id = ? AND tenant_id = ?', [contact_id, req.tenantId]);
  await logAction(req, 'log_interaction', 'interaction', id, { agent, channel });
  res.json(await db.get('SELECT * FROM interactions WHERE id = ? AND tenant_id = ?', [id, req.tenantId]));
}));

// ---- Agent action audit log (read-only) ----
app.get('/api/agent-actions', resolveTenant, ah(async (req, res) => {
  res.json(await db.all('SELECT * FROM agent_actions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200', [req.tenantId]));
}));

// ---- Export (CSV, on-request — human session only, not agent API key) ----
function toCsv(rows) {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => escape(row[h])).join(','));
  return lines.join('\n');
}

app.get('/api/export/:table.csv', ah(async (req, res) => {
  if (!(req.session && req.session.tenantId)) return res.status(401).json({ error: 'Export requires a logged-in user, not an API key' });
  const allowed = ['contacts', 'deals', 'interactions'];
  if (!allowed.includes(req.params.table)) return res.status(404).json({ error: 'Unknown export table' });
  const rows = await db.all(`SELECT * FROM ${req.params.table} WHERE tenant_id = ? ORDER BY created_at`, [req.session.tenantId]);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.table}.csv"`);
  res.send(toCsv(rows));
}));

// ---- Static frontend ----
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  if (!(req.session && req.session.tenantId)) return res.redirect('/login.html');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Error handler ----
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const DEMO_RESET_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function start() {
  await init();
  if (DEMO_MODE) {
    await resetDemoTenant();
    setInterval(() => resetDemoTenant().catch((e) => console.error('demo reset failed:', e)), DEMO_RESET_INTERVAL_MS);
    console.log('DEMO_MODE: open access as demo tenant, data auto-resets.');
  }
  app.listen(PORT, () => {
    console.log(`CRM Agent running at http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start (check DATABASE_URL):', err);
  process.exit(1);
});
