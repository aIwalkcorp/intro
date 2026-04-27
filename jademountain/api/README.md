# Trailforge API

Stateless proxy: browser → here → Anthropic Haiku 4.5. Holds the skill bundle, the
API key, validates input/output. The PWA never sees the key.

## Endpoints

- `GET  /healthz` — bundle size, key presence, model name
- `POST /customize` — `{ plan_state, phase, day_index, user_message }` →
  `{ patch, assistant_message, quick_replies, next_phase, next_day_index, warnings, usage }`

Spec: see `../skill/system-prompt.md` and `../skill/state-machine.md`.

## Local dev

```bash
cp .env.example .env       # fill in ANTHROPIC_API_KEY
bun install
bun run dev
curl localhost:4100/healthz
```

## Deploy (target: Oracle Cloud Free Tier ARM, alongside Patient Cloud)

The container is built with the skill bundle baked in (`COPY skill ./skill` in the
Dockerfile), so the build context is the whole `jademountain/` directory:

```bash
# from intro/jademountain/
docker build -t trailforge-api -f api/Dockerfile .
docker run --rm -p 4100:4100 --env-file api/.env trailforge-api
```

For the OCI compose, this becomes a service in
`ExoPulse-deploy-oci/web_UI/docker/docker-compose.yml`. Sketch:

```yaml
trailforge-api:
  build:
    context: ../../../intro/jademountain     # adjust to actual relative path
    dockerfile: api/Dockerfile
  environment:
    - ANTHROPIC_API_KEY
    - ALLOWED_ORIGINS=https://aiwalkcorp.com,https://trailforge.aiwalkcorp.com
  restart: unless-stopped
```

And an nginx route in `nginx.cloud.conf`:

```nginx
location /api/customize {
    proxy_pass http://trailforge-api:4100/customize;
    proxy_set_header Host $host;
}
```

## Security notes

- `ANTHROPIC_API_KEY` lives only in container env / OCI secrets manager
- CORS is `ALLOWED_ORIGINS` allow-list, default rejects `null` origin (file://)
- Input caps: `user_message` ≤ 2KB, `plan_state` ≤ 64KB
- Output is shape-validated before returning to the browser
- Skill bundle is loaded once at process start; re-deploy to refresh prompts

## Cost

Haiku 4.5 + 5-min prompt cache: ~NT$0.16 per turn after the first cached turn.
A full 10-turn customization session: ~NT$1.9. See `../skill/system-prompt.md` for math.
