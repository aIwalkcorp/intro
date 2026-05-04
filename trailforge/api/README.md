# Trailforge API

Bun + Hono + Postgres backend for the Trailforge PWA. Owns:
- AI proxy (`POST /customize` → Anthropic Haiku 4.5, with prompt cache + skill bundle)
- User accounts (register, login, JWT access + refresh, session management)
- Per-module settings storage (jsonb keyed by `(user_id, module, key)`)
- AI token usage + cost ledger (`ai_usage`)
- Audit log for compliance (`audit_log`)

The PWA never sees the Anthropic API key. JWT-stateless access tokens; rotating
refresh tokens stored hashed in Postgres so a DB leak doesn't yield usable tokens.

## Endpoints

### Public
- `GET  /healthz` — DB ping + bundle size + model
- `POST /auth/register` — `{email, username, password}` (rate-limited per IP)
- `POST /auth/login` — `{identifier, password}` → access + refresh token (rate-limited)
- `POST /auth/refresh` — `{refresh_token}` → new access + refresh (rotates the old)

### Authenticated (`Authorization: Bearer <access_token>`)
- `POST /auth/logout` — revokes ALL active sessions for the user
- `GET  /auth/me` — current user
- `GET  /api/settings/:module` — all settings for a module
- `PUT  /api/settings/:module/:key` — `{value: ...}` (jsonb, ≤16KB)
- `DELETE /api/settings/:module/:key`
- `GET  /api/usage` — month-to-date token + cost summary, plus 20 most recent calls
- `POST /customize` — `{plan_state, phase, day_index, user_message}` → plan patch (logs usage)

## Local dev

```bash
cp .env.example .env
# 1. Get Neon connection strings (https://console.neon.tech)
# 2. Generate JWT_SECRET (see INFRA.md §2)
# 3. Add ANTHROPIC_API_KEY

bun install
bun run db:generate    # generate SQL from schema.ts
bun run db:migrate     # apply to Neon

bun run dev            # http://localhost:4100
curl localhost:4100/healthz
```

## Build + run via Docker

The build context is `intro/trailforge/` (so the container can `COPY skill/`):

```bash
cd intro/trailforge
docker build -t trailforge-api -f api/Dockerfile .
docker run --rm -p 4100:4100 --env-file api/.env trailforge-api
```

## Deploy

See [INFRA.md](./INFRA.md) for the full Fly.io + Neon walk-through.

## Security notes

- Secrets (`ANTHROPIC_API_KEY`, `JWT_SECRET`, `DATABASE_URL`) live in Fly secrets, never in `fly.toml` or git
- Passwords hashed with argon2id (`Bun.password`, OWASP-recommended)
- Refresh tokens: opaque random 96-hex-char strings, stored as SHA-256 hash, rotated on every refresh
- CORS: `ALLOWED_ORIGINS` allow-list (no wildcard)
- Input caps: `user_message` ≤ 2KB, `plan_state` ≤ 64KB, settings `value` ≤ 16KB
- Audit log entries on register / login / login.failed / logout / refresh

## Cost

- **Compute** (Fly.io shared-cpu-1x 512MB, scale-to-zero): ~$0–5/mo at low traffic
- **DB** (Neon free tier): $0 up to 0.5GB / 100h compute-hours per month
- **Anthropic**: ~NT$0.16 per `/customize` turn after the first cached turn (~NT$1.9 / 10-turn session)

Token usage is logged per user — see `GET /api/usage` for live numbers.
