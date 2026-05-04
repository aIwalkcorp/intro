# Trailforge — 開發機 setup & 故障排除

整個 stack 都在雲端（Cloudflare Pages + Fly.io + Neon），這台機器**不是必要**。
任何人 `git clone` 後跟著本文件走 ~10 分鐘就能在新機器上跑起本地預覽。

---

## 1. 看不到剛 push 的更新（清 Service Worker 快取）

PWA 安裝過後，舊的 Service Worker 會繼續服務快取裡的舊 JS / CSS。
推了新 commit 但畫面沒變 → 大機率是 SW 還在服務舊版。

**完整清掉一次**：

1. 打開 `https://aiwalkcorp.com/jademountain/?plan=<某 id>`
2. F12 → **Application** 分頁
3. 左側 **Service Workers** → 找到 `jademountain` → 點 **Unregister**
4. 左側 **Storage** → 最上方 **Clear site data**
5. **Ctrl+Shift+R** 強制重整（繞過 HTTP cache）

之後新版 SW 接管，所有靜態資源（HTML / CSS / JS / icon）回到最新。
**只要做一次**，之後 SW 自己會跟著 cache version 升級（`sw.js` 裡的 `CACHE = 'jademountain-vN'` 每次有重大改動就會 bump，自動清舊 cache）。

iOS Safari 沒有「Unregister SW」UI → 解除 PWA 安裝再重新加入主畫面就行。

---

## 2. 換到別台電腦開發（本機 setup）

### 雲端服務（不用做任何事）

| 服務 | 狀態 |
|---|---|
| GitHub repo | clone 即可 |
| Cloudflare Pages | git push 自動 deploy 前端 |
| Fly.io | `fly deploy` 推後端，跟本機無關 |
| Neon DB | cloud-only，從哪連都行 |
| Domain / DNS | Cloudflare 託管 |

### 本機需要安裝

```bash
# A. clone
git clone git@github.com:aIwalkcorp/intro.git
cd intro

# B. 裝 bun（後端 / migration / 任何 JS 工具）
curl -fsSL https://bun.sh/install | bash

# C. 裝 fly CLI（要 deploy / 看 logs / 改 secrets 才需要）
curl -L https://fly.io/install.sh | sh
fly auth login          # 開瀏覽器授權，每台電腦各自做一次
fly auth whoami         # 確認帳號是 chatgpt420230901@gmail.com
```

### 唯一要從舊電腦複製過去的東西：`.env`

`.env` 在 `.gitignore` 裡，git 不帶。內容包含 DB URL、JWT_SECRET、Anthropic key。

**在舊電腦跑**：
```bash
cat /home/ntk/exo/ExoPulse/intro/jademountain/api/.env
```

把整段輸出複製，貼到新電腦的 `intro/jademountain/api/.env`。

⚠️ **`JWT_SECRET` 必須與 prod 一致**（也就是跟舊電腦一致）。否則本地 API 簽出的 token 換到 prod 就 invalid，反之亦然。
   - 要重 generate `JWT_SECRET` 等於要強迫所有用戶重登，prod 跟本地都要同步。

`.env.example` 是範本，可作為填寫格式參考。

### 安裝 + 啟動

```bash
cd jademountain/api
bun install                      # 裝後端依賴

# 本地預覽（兩個 terminal 各跑一個）：
bun run start                    # 後端 API @ 4100
cd ../.. && python3 -m http.server 8765   # 前端靜態 @ 8765
```

### 本地預覽 URL

```
http://localhost:8765/jademountain/dashboard.html?api=http://localhost:4100
```

`?api=http://localhost:4100` 是必要的 — 沒帶就會打到 prod fly.dev，被 CORS 擋。
從 dashboard 點任一張卡進去，URL 會自動帶 `?api=` 給 plan view。

---

## 3. 多裝置同時開發

完全可以。每台電腦各自 `git pull` / `git push`，Cloudflare / Fly 不在乎是誰 push 的。

**唯一注意**：兩台電腦本地 `.env` 應指向同一個 Neon SG project（已遷移過去）+ 同一個 `JWT_SECRET`。否則「本地寫的資料 prod 看不到」「本地 token prod 拒絕」之類的 bug 會冒出來。

---

## 4. Region / DB 配置（給未來 me 用）

| 元件 | Region | 為什麼 |
|---|---|---|
| Cloudflare Pages | global edge | 自動，全球低延遲 |
| Fly.io app `trailforge-api` | `sin` (Singapore) | 跟 Neon 同 region 省 DB 延遲 |
| Neon project | `aws-ap-southeast-1` (Singapore) | 跟 Fly 同 region；對 TW 用戶 ~50ms |

舊的 us-east-1 Neon project 已退役（5 天閒置 Neon 自動 suspend）。
登入流程從遷移前 ~1.3 秒降到 ~250ms（cold start 仍會 ~400ms）。

---

## 5. 故障排除速查

| 症狀 | 通常原因 |
|---|---|
| 推了 commit 但網頁沒變 | SW cache → 跟著上面 §1 清一次 |
| `儲存失敗：Failed to fetch` | 網路斷 → outbox 自動暫存，看右上角 ⬆ 上傳按鈕 |
| `儲存失敗：HTTP 401` | access_token 過期（15 分鐘 TTL）→ 重登 |
| dashboard 顯示空白「載入中…」 | 沒帶 `?api=`，或本地 API 沒跑 |
| 改名後行程表標題沒跟著變 | 檢查 `data.meta.title` 是否同步（後端 PATCH 時自動同步）|
| Fly logs 看 503 | DB 連不到，檢查 `flyctl secrets list` 看 `DATABASE_URL` |

詳細 debug：
```bash
flyctl logs --app trailforge-api    # prod 後端日誌
flyctl ssh console --app trailforge-api  # 進去 prod 機器
```
