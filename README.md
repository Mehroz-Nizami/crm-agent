# CRM Agent

The shared data/API layer for the AI Agent Suite. Lead Qualifier, AI Sales, AI Voice, Customer
Support, and Internal Workflow agents do not get their own databases — they all read and write
through this API. See `../architecture.md` for the reasoning.

## Two ways to call this API

- **Human dashboard (session cookie):** `POST /api/login` with `{ email, password }`. Used by
  the login/dashboard pages in `public/`. Tied to one tenant per user.
- **Agent-to-agent (API key):** send header `x-api-key: <tenant's api_key>` plus
  `x-agent-name: <lead_qualifier|sales|voice|support|workflow>` on every request. This is how the
  other 5 agents will call in — every write made this way gets logged to `agent_actions` for the
  audit trail. Session calls do NOT get logged there (that table tracks agent activity, not every
  human click).

Every tenant's `api_key` is generated on creation and stored in the `tenants` table — there's no
endpoint to list it (avoid leaking it over HTTP); pull it from the DB directly when wiring up a
new agent, or extend `/api/session` later to surface it to a logged-in owner.

## Endpoints

- `GET/POST /api/contacts`, `PATCH /api/contacts/:id`
- `GET/POST /api/deals`, `PATCH /api/deals/:id`
- `GET/POST /api/interactions` (also updates the contact's `updated_at`)
- `GET /api/agent-actions` (read-only audit log)
- `GET /api/export/{contacts|deals|interactions}.csv` — human session only, not API-key callable
  (this is the "export on request" offboarding path decided in the architecture spec)

## Local dev

```
npm install
DATABASE_URL=postgresql://... npm start
```

On first run against an empty database, seeds one demo tenant:

- Login: `demo@auberix.test` / `demo1234`
- A console line prints the demo tenant's API key on first boot — save it, it's not shown again
  through the app itself.

## Deploy

Same pattern as DispatchAI/RoastRadar: Render Blueprint reads `render.yaml`. Needs its own Neon
project (`crm-agent`) — don't reuse another project's `DATABASE_URL`, this is a different schema.

## Multi-tenancy note

One deploy serves every client (`tenants` table), not one deploy per client. That's what makes
this resellable instead of bespoke-per-client work — see open questions in `architecture.md`
before onboarding a real second tenant (there's currently no self-serve signup flow; new tenants
are created by inserting a row directly, which is fine for the first few pilots but won't scale
past that).
