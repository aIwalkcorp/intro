# Trailforge Infrastructure Guide

End-to-end deploy guide for the API on Fly.io with Postgres on Neon.
This is the "mature SaaS skeleton" — replicate the same pattern for future services.

## 1. Provision Postgres (Neon)

1. Create a free Neon account: https://console.neon.tech
2. Create project `trailforge` in region `Asia Pacific (Tokyo)` (closest to Fly `nrt`)
3. Inside the project, create two **branches**:
   - `main` — production
   - `dev` — development (Neon branches are copy-on-write, near-instant, free)
4. From each branch's "Connection details" panel, copy:
   - **Pooled** connection string → `DATABASE_URL` (used by app at runtime)
   - **Direct** connection string → `DATABASE_URL_UNPOOLED` (used by migrations)

Why pooled for runtime: Neon's serverless model spins compute up/down. The pooler
holds warm connections so cold-start latency stays low. Direct connections are
required for some Postgres features (e.g. `LISTEN/NOTIFY`, prepared statements
in transaction-mode pooling), and for migrations which use a single connection.

## 2. Generate JWT secret

```bash
bun -e "console.log(crypto.getRandomValues(new Uint8Array(48)).reduce((s,b)=>s+b.toString(16).padStart(2,'0'),''))"
```

Save it — you'll set it as a Fly secret in step 4.

## 3. Run migrations against Neon

From `intro/trailforge/api/`:

```bash
cp .env.example .env
# fill in DATABASE_URL_UNPOOLED, JWT_SECRET, ANTHROPIC_API_KEY

bun install
bun run db:generate    # creates SQL files in src/db/migrations/ from schema.ts
bun run db:migrate     # applies them to Neon
```

Commit the generated migrations to git — they are the source of truth for schema history.

## 4. Deploy to Fly.io

One-time setup:

```bash
# Install Fly CLI
curl -L https://fly.io/install.sh | sh

# Auth
fly auth login

# From intro/trailforge/, NOT from api/ (Dockerfile context is trailforge/)
cd intro/trailforge
fly launch --no-deploy --copy-config --name trailforge-api --region nrt
```

Set secrets (these never appear in fly.toml or git):

```bash
fly secrets set \
  DATABASE_URL="postgresql://...neon.tech/trailforge?sslmode=require" \
  JWT_SECRET="<the 96-hex-char string from step 2>" \
  ANTHROPIC_API_KEY="sk-ant-..." \
  --app trailforge-api
```

Deploy:

```bash
fly deploy --app trailforge-api
```

Verify:

```bash
fly status --app trailforge-api
fly logs --app trailforge-api
curl https://trailforge-api.fly.dev/healthz
```

## 5. DNS / TLS

Point `trailforge.aiwalkcorp.com` to Fly:

```bash
fly certs create trailforge.aiwalkcorp.com --app trailforge-api
fly certs show trailforge.aiwalkcorp.com --app trailforge-api  # shows DNS records to add
```

Add the shown CNAME / A / AAAA records at your DNS provider (Cloudflare etc.). Cert auto-renews.

## 6. Frontend points at the API

In `intro/trailforge/render.js` (or wherever the API base URL lives), set:

```js
const API_BASE = "https://trailforge.aiwalkcorp.com";   // or trailforge-api.fly.dev pre-DNS
```

## 7. Operational checklist

- [ ] Health: `GET /healthz` returns 200 with `db: "ok"`
- [ ] Register: `POST /auth/register` returns 201 with user object
- [ ] Login: `POST /auth/login` returns access_token + refresh_token
- [ ] Authed call: `GET /auth/me` with `Authorization: Bearer <access_token>` returns user
- [ ] Customize: `POST /customize` with auth header returns plan patch
- [ ] Token usage logged: `GET /api/usage` shows the customize call

## 8. Upgrade paths (when scale demands it)

| Trigger | Upgrade |
|---|---|
| > 1 instance | Replace in-memory rate limit with Upstash Redis (free tier, REST API) |
| > 10K users | Move from Neon free → Neon Pro (autoscaling, point-in-time recovery) |
| Need email | Add Resend integration for verification + password reset |
| Need observability | Wire Sentry SDK + structured-log shipping to Axiom or BetterStack |
| Multi-region | `fly scale count 2 --region nrt,sin` and use Fly Postgres replicas or Neon read replicas |

## 9. Local development

```bash
cd intro/trailforge/api
cp .env.example .env   # fill DATABASE_URL pointing to Neon dev branch (or local Postgres)
bun install
bun run db:migrate     # apply schema
bun run dev            # http://localhost:4100
```

## 10. Things deliberately NOT done yet

- Email verification + password reset flow (needs SMTP / Resend)
- 2FA / MFA (TOTP)
- OAuth providers (Google / Apple)
- Rate limit via Redis (single-instance is fine for now)
- Sentry / log aggregation
- `user_plans` table + edit-mode routes (waiting on edit-mode spec)
