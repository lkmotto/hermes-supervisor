# Hermes Supervisor

Hermes is an MCP-based business operations PM agent. It coordinates research, VPS inspection, memory, planning, fleet integration, online learning, Perplexity shadow ingestion, and Telegram-driven operator workflows through a Model Context Protocol server.

## Runtime and Deployment

- Runtime: Node.js 24, TypeScript, MCP SDK, `sql.js` memory database.
- Local entrypoint: `node dist/index.js --http`.
- Production model: Hostinger VPS `srv1511806`, Docker Compose project `hermes`, HTTP MCP service on port `8150`.
- Production Compose path: `/docker/hermes/docker-compose.yml`.
- Persistent data: `HERMES_DB_PATH`, normally backed by the Hermes Docker volume at `/data/hermes.db`.
- Source deployment currently clones `lkmotto/hermes-supervisor` from `master` at container start, installs dependencies, builds, then starts Hermes on `0.0.0.0:8150`.

## Environment Variables

Required for the full production capability set, listed by key name only:

- `HOSTINGER_API_TOKEN`
- `PERPLEXITY_API_KEY`
- `MOTTO_MCP_URL`
- `MOTTO_MCP_AUTH_TOKEN`
- `TELEGRAM_BOT_TOKEN`

Common runtime/configuration keys:

- `HERMES_VPS_ID`
- `HERMES_DB_PATH`
- `HERMES_FLEET_AGENT_NAME`
- `HERMES_AUTONOMY_LEVEL`
- `MOTTO_SKILLS_TOOLS_DIR`
- `MOTTO_KNOWLEDGE_DIR`
- `HERMES_BUILD_COMMIT`
- `HERMES_BUILD_REF`
- `HERMES_BASE_URL`
- `HERMES_URL`

Secrets are injected from Doppler for production use. `TELEGRAM_BOT_TOKEN` is stored in Doppler and must be a valid BotFather token; do not commit, print, or paste the token value. The current Doppler value is known to return Telegram `401` until replaced with a valid BotFather token.

## Common Commands

```bash
npm ci
npm run build
npm run typecheck
node --test tests/*.test.mjs
```

Notes:

- `npm run build` generates build metadata and compiles TypeScript.
- There is no `npm test` script; use `node --test tests/*.test.mjs` for the integration test files.
- Integration tests expect a running Hermes HTTP MCP service, usually at `http://127.0.0.1:8150`, plus the required Doppler-backed integrations.

## Run Locally

```bash
npm ci
npm run build
doppler run --project motto-core --config prd -- npm run start:http -- --host 127.0.0.1 --port 8150
```

Health check:

```bash
curl -sS http://127.0.0.1:8150/health
```

## Deploy with Doppler and Docker Compose

Production deployment is Hermes-scoped and should not disturb unrelated VPS services.

```bash
cd /docker/hermes
doppler run --project motto-core --config prd -- docker compose up -d --build hermes
curl -sS http://127.0.0.1:8150/health
```

For the current Compose model, validated source should be on `master` before restarting the Hermes Compose project, because the container clones the repository at startup.

## Capabilities

Key MCP and operator capabilities include:

- Research via Perplexity-backed `research`.
- Hostinger VPS read tools for info, metrics, Compose projects, and project logs.
- Risk-gated VPS mutation tools that fail closed without explicit confirmation and approval policy.
- Local memory and planning tools, including secret redaction before persistence.
- Fleet registration, event/artifact integration, retry/audit state, and business PM loop coordination.
- Online learning records, workflow/decision/postmortem/fact persistence, and capability request tracking.
- Perplexity shadow ingestion through push-based MCP context capture.
- Telegram bot integration for `/status`, `/cycle`, `/perplexity`, and freeform observation capture, pending a valid BotFather token in Doppler.
- Deployment traceability through build metadata and `/health`.

## Validation Status

The end-of-mission validation state reports `75/75` assertions passed. The final evidence bundle is stored in the mission library for mission `4edc4c4a-5efd-4595-9cad-ef8e305de126`.

## Safety Notes

- Never include secret values in commits, logs, README edits, MCP outputs, or validation evidence.
- Keep Hermes on port `8150`.
- Do not restart the whole VPS or unrelated Docker Compose projects.
- Mutating VPS actions require the configured Hermes risk policy and explicit approval fields.
- Preserve the Hermes data volume and `/data/hermes.db`.
- Use Doppler/runtime injection for deployment secrets; `/docker/hermes/.env` must not contain plaintext secret values.
