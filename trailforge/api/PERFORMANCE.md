# Trailforge API — Cold Start & Performance Notes

## TL;DR

The API is on Fly.io with `min_machines_running = 0` (scale-to-zero). First
request after idle pays ~400ms-1s cold start; warm requests are ~250ms RTT
(TW → Singapore region, where Neon DB is co-located).

We decided to **stay on the free tier (`min=0`)** for now. To eliminate cold
start later, set `min_machines_running = 1` and `fly deploy` — costs ~$3-5/mo.

## Where time goes on a login

| Phase | Cold | Warm |
|---|---|---|
| Cloudflare → Fly proxy | ~30ms | ~30ms |
| **Fly machine resume from suspend** | **~400-1000ms** | **0** |
| TLS handshake (client → fly.dev) | ~50-100ms | 0 (preconnect) |
| TCP / HTTP routing | ~10ms | ~10ms |
| Bun + Hono request handler | ~5ms | ~5ms |
| **Argon2 password verify** | **~150-300ms** | **~150-300ms** |
| DB query (Neon Singapore) | ~30ms | ~30ms |
| JWT sign + session insert | ~20ms | ~20ms |
| Response back to client | ~50ms | ~50ms |
| **TOTAL** | **~700-1500ms** | **~250-400ms** |

Argon2 is the dominant remaining cost on warm requests and is intentional
(security). We use OWASP-recommended params: `argon2id, m=19MiB, t=2`. Lower
costs would reduce password resistance.

## Mitigations already in place

- **`auth.html` preconnect + DNS prefetch** (`<link rel="preconnect">`) opens
  the TLS connection on page load. By the time the user submits credentials,
  the handshake is done.
- **`auth.html` `/healthz` prefetch on load** wakes the Fly machine while the
  user is still typing. For a typical 5-15s form fill, the machine is fully
  resumed by the time the user clicks submit.
- **edit.js outbox queue** (`TF_OUTBOX`) catches transient network failures
  and retries on online events — so an unlucky cold start mid-save doesn't
  drop user data.

## Cost / latency trade-offs

| Setting | $ per month | Cold start | Notes |
|---|---|---|---|
| `min=0` (current) | ~$0-0.5 | ~700-1500ms first req | Suspended is free. Idle from ~5 min → suspend. |
| `min=1`, 512MB | ~$3-5 | ~0 (always warm) | One machine 24/7. Burst still scales up. |
| `min=1`, 256MB | ~$1.5-2 | ~0 | Same as above, smaller VM. Tight for bun+drizzle but viable. |
| `min=2`, 512MB | ~$6-10 | ~0 + HA | Two regions or two machines for redundancy. |

Suspended state on Fly is genuinely free — no compute, no RAM, only the few
KB of metadata. So an idle deployment costs basically nothing.

## Bumping to `min=1` later

When the user complaint about cold starts justifies the cost:

```bash
# In trailforge/fly.toml, change min_machines_running 0 → 1
# Then deploy:
cd intro/trailforge
fly deploy --dockerfile api/Dockerfile

# Or skip the build and just adjust runtime config (faster):
fly machines update <MACHINE_ID> --schedule never -a trailforge-api
```

Sanity-check after deploy:

```bash
fly status -a trailforge-api          # should show 1+ machines started
fly machine list -a trailforge-api    # state column should read "started"
curl -sS -o /dev/null -w "%{time_total}s\n" https://trailforge-api.fly.dev/healthz
# expect ~0.25s warm
```

## Other speedups worth considering (if needed)

- **Pre-warm from corp index.html / dashboard.html** — add `/healthz` prefetch
  there too so machines wake before the user even reaches auth.html.
- **Reduce argon2 cost** — would shave 50-150ms off warm logins but lowers
  password security. Not recommended unless we add 2FA or rate limiting.
- **Move auth to Cloudflare Workers** — sub-50ms cold start, edge-distributed.
  Big architectural lift; only worth it at much larger scale.
- **Connection pool warmup on machine boot** — server.ts could PING DB once
  on startup so the first real request doesn't pay pool-init cost.

## History

- 2026-05-04 — initial note. App on `min=0`, two suspended machines in `sin`.
  Frontend gained `/healthz` prefetch + preconnect to mask first-request cost.
- (next entry: when we flip to `min=1`)
