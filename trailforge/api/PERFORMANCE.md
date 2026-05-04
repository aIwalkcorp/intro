# Trailforge — 雲端架構、效能、計費總覽

## TL;DR

目前 5 個雲端服務，跑在免費或極低費用區段。Login 體感冷啟 700–1500ms、熱
請求 250–400ms。多人正式上線預估月費 ~$25-60 USD（最大宗是 Anthropic API
按用量收費）。

---

## 雲端服務分工

```
┌──────────────────────────────────────────────────────────────────┐
│                            User Browser                           │
└──────────┬─────────────────────────────────┬─────────────────────┘
           │                                 │
       (HTML/CSS/JS)                  (POST /auth, /api/*)
           ▼                                 ▼
┌────────────────────────┐      ┌────────────────────────────────┐
│  Cloudflare Pages       │      │  Fly.io  (sin region)          │
│  • aiwalkcorp.com       │      │  • trailforge-api.fly.dev      │
│  • CF DNS / TLS / CDN   │      │  • Bun + Hono server (1 VM)    │
│  • Auto-deploy on push  │      │  • Issues JWTs, stores plans   │
└─────────┬───────────────┘      └────────┬───────────────────────┘
          │ build trigger                  │ SQL over TLS (~30ms)
          ▼                                 ▼
┌────────────────────────┐      ┌────────────────────────────────┐
│  GitHub                 │      │  Neon Postgres (sin)           │
│  • aIwalkcorp/intro     │      │  • aws-ap-southeast-1          │
│  • Code + commit history│      │  • users / sessions / plans    │
└─────────────────────────┘      └────────────────────────────────┘
                                                   │
                                                   │ (only /api/customize)
                                                   ▼
                                  ┌────────────────────────────────┐
                                  │  Anthropic API                  │
                                  │  • claude-haiku-4-5             │
                                  │  • AI 客製計畫書 / 助理         │
                                  └────────────────────────────────┘
```

### Cloudflare Pages — 前端託管 + DNS

- **託管 `aiwalkcorp.com/trailforge/*`** 全部靜態資源（HTML、JS、CSS、圖示、
  PWA manifest、Service Worker）。
- 全球 edge CDN，讀取延遲對 TW 用戶 ~10-30ms。
- **DNS** 也是 Cloudflare 託管（NS records）。網域 `aiwalkcorp.com` 跟
  `_redirects` 重導規則由它處理。
- 每次 git push 到 `main` 自動 build + deploy，~30 秒上線。

### Fly.io — 後端 API

- **跑 `trailforge-api.fly.dev`**（Bun + Hono server，`api/src/server.ts`）。
- 機器在 `sin`（Singapore）region，跟 DB 同區延遲 ~30ms。
- 提供 `/auth/*`（註冊、登入、token 刷新）、`/api/plans/*`（CRUD）、
  `/api/customize`（AI 助理生成計畫書）。
- 設定 `auto_stop_machines = "suspend"` → 閒置時 suspend（free），有請求才
  resume（cold start ~400-1000ms）。
- Secrets（`DATABASE_URL`、`JWT_SECRET`、`ANTHROPIC_API_KEY`）透過
  `fly secrets set` 注入，不進 git。

### Neon — Postgres 資料庫

- **`aws-ap-southeast-1` Singapore**，跟 Fly.io 同 region。
- 儲存 `users`、`sessions`、`plans`、`audit_logs`、`ai_usage` 等 table。
- Schema 用 Drizzle ORM 管理（`api/src/db/schema.ts`），migrations 在
  `api/src/db/migrations/`。
- 自帶 connection pooling（pgBouncer）— `DATABASE_URL` 走 pooled，
  `DATABASE_URL_UNPOOLED` 走 direct（migration 用）。
- 閒置 5 分鐘後 compute 自動 suspend（跟 Fly 一樣免費）。

### GitHub — 程式碼倉儲

- `aIwalkcorp/intro`，git history 唯一真相。
- Cloudflare Pages 透過 GitHub App 整合監聽 push，自動觸發 build。
- 沒有額外 CI/CD（沒用 Actions），CI 等於「Cloudflare build 失敗就跳信」。

### Anthropic API — AI

- Claude Haiku 4.5（`claude-haiku-4-5-20251001`，廉價快速款）。
- 只有 `/api/customize` 用：用戶填基本參數 → Claude 產生完整計畫書 JSON。
- 按 token 計費（input + output 分開），用得越多越貴。
- 目前用量低；正式上線後可能成本最大宗。

### 沒用到、但常被誤以為有的

- **CDN for assets**：圖示、字體 — 字體走 Google Fonts CDN，圖示用本地
  PNG（已被 SW 預快取）。
- **Object storage（S3/R2）**：暫無，計畫書都是 JSON 存在 Neon 的 jsonb
  欄位裡。如果未來支援照片上傳要再加。
- **Analytics**：暫無，Cloudflare 內建的 Web Analytics 沒開。
- **Email service**：暫無，註冊驗證 email 還沒實作（`emailVerifiedAt`
  欄位已預留）。

---

## 效能：login 一次的時間都花在哪

| 階段 | Cold | Warm |
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

Argon2 是熱請求剩下最大宗，是有意設計（密碼安全）。我們用 OWASP 推薦的
`argon2id, m=19MiB, t=2`，降下來會犧牲抗暴力破解能力。

### 已經做的優化

- **`auth.html` preconnect + DNS prefetch** 一進頁面就開 TLS 通道，submit
  時不用再付 handshake。
- **`auth.html` `/healthz` prefetch** 進頁面就 wake Fly machine，用戶填表的
  5–15 秒讓機器有時間 resume。
- **`edit.js` outbox queue** 網路掉了會排隊重送，cold start 失敗也不丟資料。

---

## 計費 vs 體感延遲

### 目前（個人測試 / MVP 階段）

| 服務 | 方案 | 月費 |
|---|---|---|
| Cloudflare Pages | Free | $0 |
| Cloudflare DNS | Free | $0 |
| Fly.io | shared-cpu-1x@512MB, `min=0` | ~$0–0.5（看用量） |
| Neon | Free（0.5GB 儲存、191.9 compute hr/月） | $0 |
| Anthropic API | pay-per-token | <$1（測試量） |
| GitHub | Free（私有 repo 也行） | $0 |
| **合計** | | **~$0–2 / 月** |

**對應體感**：
- 第一次 / idle 後第一個請求：**~700–1500ms**（cold start）
- 接續請求：**~250–400ms**

### 正式多人上線（百到千人 DAU）

| 服務 | 方案 | 月費 |
|---|---|---|
| Cloudflare Pages | Free（500 builds/月、無流量上限）夠用 | $0 |
| Cloudflare DNS | Free | $0 |
| Fly.io | `min=1`、shared-cpu-1x@512MB（永遠至少一台） | ~$3–5 |
| Fly.io | 流量費用（出站 ~每 GB $0.02） | ~$1–5 |
| Neon | **Pro 方案**（10GB、永遠 warm、point-in-time restore） | $19 |
| Anthropic API | 每月生成 ~1000 個 AI 計畫書 × Haiku 約 $0.005 | ~$5–20 |
| GitHub | Free 仍夠 | $0 |
| **合計** | | **~$28–50 / 月** |

**對應體感**：
- 第一次請求：**~250–400ms**（無 cold start）
- 接續請求：**~250–400ms**（一致）

### 規模再上去（千到萬人 DAU）

| 服務 | 方案 | 月費 |
|---|---|---|
| Fly.io | 多 region（`sin` + `nrt` 或 `sea`）、`min=2` 各一台 | ~$15–30 |
| Fly.io | 流量 + IPv4 share | ~$5–20 |
| Neon | **Scale 方案**（200 GB、autoscaling compute） | $69+ |
| Anthropic API | 每月 ~10,000 計畫書 | ~$50–200 |
| Cloudflare Workers（如要 edge auth） | ~$5/月 + 用量 | ~$5–15 |
| Object storage（如加照片功能）| Cloudflare R2 | ~$0–10 |
| Email service（SendGrid / Resend / Postmark） | 註冊 / 通知 | ~$10–20 |
| **合計** | | **~$150–300 / 月** |

**對應體感**：
- 全球 edge：TW/HK/JP 用戶 **~150-250ms**
- 美洲用戶 ~300-400ms（要 us-east-1 region 才優化）

---

## 從現狀升級的順序建議

當以下情況觸發時，按優先序升級：

1. **使用者抱怨 login 偶爾慢**（cold start）→ Fly `min=0 → 1`，加 ~$3-5/月
2. **Neon free tier 量超過**（>0.5GB 或 191 compute hr）→ Neon Free → Pro，加 $19/月
3. **AI 用量爆量**（每月 >1000 次 customize）→ 換 Sonnet 模型 / 加 prompt 快取，按需求
4. **想加註冊驗證 / 通知 email** → 接 Resend 或 Postmark，~$10/月起
5. **要支援照片附件**（隊員照、地形照）→ Cloudflare R2，按用量
6. **流量爆量**（>5000 DAU 跨 region）→ Fly 多 region 部署，加 ~$10-30/月

---

## 升級到 `min=1` 的步驟

當 cold start 抱怨大於 ~$3-5/月成本時：

```bash
# 編輯 trailforge/fly.toml 把 min_machines_running 改 0 → 1
# 然後 deploy：
cd intro/trailforge
fly deploy --dockerfile api/Dockerfile

# 或不重 build，只調整 runtime config：
fly machines update <MACHINE_ID> --schedule never -a trailforge-api
```

驗證：

```bash
fly status -a trailforge-api          # 應有至少一台 started
fly machine list -a trailforge-api    # state 欄是 "started"
curl -sS -o /dev/null -w "%{time_total}s\n" https://trailforge-api.fly.dev/healthz
# 預期 ~0.25s warm
```

---

## 其他可考慮的速度優化（暫不做）

- **dashboard.html / 公司首頁也加 `/healthz` prefetch** — 用戶到登入頁前就
  把 Fly 機器先 wake 起來。
- **Argon2 cost 降低** — 可省 50-150ms 但密碼抗破解力下降。除非加 2FA 或更
  強的 rate limit，否則不建議。
- **Auth 搬到 Cloudflare Workers** — sub-50ms cold start、edge 全球分布。
  架構改動大，規模到 1k+ DAU 才划算。
- **Server boot 時 ping DB 一次** — 第一個真正請求不用付 connection pool
  init 的代價。

---

## 變更紀錄

- 2026-05-04 — 初版。`min=0` 階段，frontend prefetch + `/healthz` 已就位。
- （下次更新：升級到 `min=1` 時補登）
