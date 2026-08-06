#!/usr/bin/env python3
"""
CopyMe 復刻 — 上傳 LINE 聊天紀錄 → 選人 → 蒸餾人格 → 對話。
aiwalkcorp 第五套產品。單檔 FastAPI 後端，跑在 fly.io。

流程：
  POST /api/upload   多部位上傳 .txt → 解析（tab/space 雙格式）→ 回傳人物名單
  POST /api/distill  SSE 串流：Claude 蒸餾指定人物 → persona.md 存 /data
  POST /api/chat     SSE 串流：以 persona 為 system prompt 對話（歷史由前端帶）
  GET  /api/personas 已蒸餾人格清單

隱私：語料只存在本服務 volume（/data），不進任何版控；ACCESS_CODE 擋隨機訪客。
"""

from __future__ import annotations

import json
import os
import re
import secrets
import unicodedata
from collections import Counter
from datetime import datetime, timezone, timedelta
from pathlib import Path

import anthropic
import httpx
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import PlainTextResponse
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse

DATA = Path(os.environ.get("PF_DATA", "/data"))
UPLOADS = DATA / "uploads"
PERSONAS = DATA / "personas"
for d in (UPLOADS, PERSONAS):
    d.mkdir(parents=True, exist_ok=True)

ACCESS_CODE = os.environ.get("ACCESS_CODE", "")
MODEL = os.environ.get("PF_MODEL", "claude-opus-5")
FALLBACK_MODEL = os.environ.get("PF_FALLBACK_MODEL", "claude-sonnet-5")
TZ = timezone(timedelta(hours=8))

# ---- 體驗額度池：伺服器自己記帳（API 無法查帳戶餘額，且 key 與其他服務共用）
BUDGET_USD = float(os.environ.get("PF_BUDGET_USD", "5"))
SPEND_FILE = DATA / "spend.json"
# 每百萬 token 價目（cache 寫 = in×1.25、cache 讀 = in×0.1）
_PRICES = {
    "claude-opus-5":   {"in": 5.0, "out": 25.0},
    "claude-sonnet-5": {"in": 3.0, "out": 15.0},
}
TWD_PER_USD = float(os.environ.get("PF_TWD_PER_USD", "31"))
MARGIN = float(os.environ.get("PF_MARGIN", "1.5"))  # 服務毛利倍率
WALLETS = DATA / "wallets"
WALLETS.mkdir(parents=True, exist_ok=True)


def _wpath(uid: str) -> Path:
    return WALLETS / f"{re.sub(r'[^\w-]', '', uid)}.json"


def wallet_get(uid: str) -> float:
    try:
        return json.loads(_wpath(uid).read_text())["twd"]
    except (OSError, ValueError, KeyError):
        return 0.0


def wallet_add(uid: str, twd: float) -> float:
    bal = wallet_get(uid) + twd
    _wpath(uid).write_text(json.dumps({"twd": round(bal, 2)}))
    return bal


def _spent() -> float:
    try:
        return json.loads(SPEND_FILE.read_text())["usd"]
    except (OSError, ValueError, KeyError):
        return 0.0


def track_usage(usage, user=None, model: str | None = None) -> None:
    p = _PRICES.get(model or MODEL, _PRICES["claude-opus-5"])
    cost = (
        usage.input_tokens * p["in"]
        + usage.output_tokens * p["out"]
        + (getattr(usage, "cache_creation_input_tokens", 0) or 0) * p["in"] * 1.25
        + (getattr(usage, "cache_read_input_tokens", 0) or 0) * p["in"] * 0.1
    ) / 1e6
    # 登入且錢包有餘額 → 扣個人錢包（成本×毛利倍率×匯率）；否則吃站方體驗池
    if user and wallet_get(user["id"]) > 0:
        wallet_add(user["id"], -cost * MARGIN * TWD_PER_USD)
        return
    tmp = SPEND_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"usd": _spent() + cost}))
    tmp.replace(SPEND_FILE)


def budget_left() -> float:
    return max(0.0, BUDGET_USD - _spent())


def check_budget(user=None) -> None:
    if user and wallet_get(user["id"]) > 0:
        return
    if budget_left() <= 0:
        raise HTTPException(402, "站方體驗額度用完了——登入後儲值自己的錢包即可繼續，或晚點再來！")

# ---- 會員：與 TrailForge 共用帳號（token 由 trailforge-api 簽發，這裡代理驗證）
TF_API = os.environ.get("TF_API", "https://trailforge-api.fly.dev")
TEAM_EMAILS = {e.strip().lower() for e in os.environ.get("PF_TEAM_EMAILS", "").split(",") if e.strip()}
_auth_cache: dict = {}


def resolve_user(authorization: str | None):
    """Bearer token → trailforge /me 驗證（快取 10 分鐘）。無效回 None。"""
    import time
    if not authorization or not authorization.startswith("Bearer "):
        return None
    tok = authorization[7:]
    hit = _auth_cache.get(tok)
    if hit and hit[0] > time.time():
        return hit[1]
    try:
        r = httpx.get(f"{TF_API}/auth/me",
                      headers={"Authorization": f"Bearer {tok}"}, timeout=8)
        if r.status_code != 200:
            return None
        user = r.json()
    except httpx.HTTPError:
        return None
    if len(_auth_cache) > 500:
        _auth_cache.clear()
    _auth_cache[tok] = (time.time() + 600, user)
    return user


def is_team(user) -> bool:
    return bool(user) and user.get("email", "").lower() in TEAM_EMAILS


def require_user(authorization: str | None):
    user = resolve_user(authorization)
    if not user:
        raise HTTPException(401, "登入後才能上傳與蒸餾（示範分身不用登入就能聊）")
    return user


claude = anthropic.Anthropic()

app = FastAPI(title="Imprint")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ---------------------------------------------------------------- LINE 匯出解析
# 移植自 diary/LINE_Memory/scripts/parse_line_export.py（雙格式：tab / space）

DATE_RE = re.compile(
    r"^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})"
    r"\s*[（(]?\s*(?:星期|週|周|禮拜)?[一二三四五六日天]?"
    r"(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday"
    r"|Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\s*[)）]?\s*$"
)
TIME_RE = re.compile(r"^((?:上午|下午|AM|PM)?\s*\d{1,2}:\d{2})([\t ])(.*)$", re.DOTALL)
HEADER_TITLE_RE = re.compile(r"^\[LINE\]\s*(?:與|Chat history with)\s*(.+?)\s*的?聊天記錄?")
SYSTEM_RE = re.compile(
    r"(已收回訊息|收回了訊息|加入(了|本)?(聊天|群組|此)|邀請了|已退出|退出了|"
    r"將.+移出|開啟了|關閉了|變更.+名稱|unsent a message|joined|left|invited)"
)
MEDIA_TOKENS = {"[照片]", "[貼圖]", "[影片]", "[檔案]", "[語音訊息]", "[相簿]", "[連結]",
                "[Photo]", "[Sticker]", "[Video]", "[File]", "[Voice message]"}


def to_24h(t: str) -> str:
    t = t.strip()
    ampm = "am" if t.startswith("上午") or t.upper().startswith("AM") else \
           "pm" if t.startswith("下午") or t.upper().startswith("PM") else None
    g = re.search(r"(\d{1,2}):(\d{2})", t)
    if not g:
        return t
    hh, mm = int(g.group(1)), int(g.group(2))
    if ampm == "pm" and hh != 12:
        hh += 12
    if ampm == "am" and hh == 12:
        hh = 0
    return f"{hh:02d}:{mm:02d}"


def detect_format(lines: list[str]) -> str:
    tab = space = 0
    for line in lines:
        m = TIME_RE.match(line)
        if m:
            tab += m.group(2) == "\t"
            space += m.group(2) == " "
        if tab + space > 500:
            break
    return "tab" if tab >= space else "space"


def detect_senders(lines: list[str]) -> list[str]:
    first: Counter = Counter()
    pair: Counter = Counter()
    msg_lines = 0
    for line in lines:
        m = TIME_RE.match(line)
        if not m or m.group(2) != " ":
            continue
        msg_lines += 1
        parts = m.group(3).split(" ")
        if parts and parts[0]:
            first[parts[0]] += 1
        if len(parts) >= 2:
            pair[(parts[0], parts[1])] += 1
    if not msg_lines:
        return []
    threshold = max(20, msg_lines * 0.01)
    senders = []
    for tok, n in first.most_common():
        if n < threshold:
            break
        if SYSTEM_RE.search(tok):
            continue
        best2 = sorted(((s, c) for (f, s), c in pair.items() if f == tok), key=lambda x: -x[1])
        if best2 and best2[0][1] >= n * 0.9 and not SYSTEM_RE.search(best2[0][0]):
            senders.append(f"{tok} {best2[0][0]}")
        else:
            senders.append(tok)
    senders.sort(key=len, reverse=True)
    return senders


def split_sender(rest: str, senders: list[str]):
    for name in senders:
        if rest == name:
            return name, "", False
        if rest.startswith(name + " "):
            return name, rest[len(name) + 1:], False
        if rest.startswith(name) and SYSTEM_RE.search(rest[len(name):]):
            return name, rest[len(name):], True
    return None, rest, False


def parse_export(text: str) -> dict:
    """回傳 {room, messages:[{date,time,sender,text}]}"""
    lines = [ln.rstrip("\r\n") for ln in text.splitlines()]
    room = ""
    for line in lines[:5]:
        hm = HEADER_TITLE_RE.match(line)
        if hm:
            room = hm.group(1).strip()
            break
    fmt = detect_format(lines)
    senders = detect_senders(lines) if fmt == "space" else []

    msgs: list[dict] = []
    cur_date = None
    last: dict | None = None
    for line in lines:
        if HEADER_TITLE_RE.match(line):
            last = None
            continue
        dm = DATE_RE.match(line.strip())
        if dm and 2011 <= int(dm.group(1)) <= 2030:
            cur_date = f"{int(dm.group(1)):04d}-{int(dm.group(2)):02d}-{int(dm.group(3)):02d}"
            last = None
            continue
        tm = TIME_RE.match(line)
        if tm and cur_date:
            rest = tm.group(3)
            if fmt == "tab":
                parts = rest.split("\t")
                if len(parts) >= 2:
                    sender, body = parts[0], "\t".join(parts[1:])
                    is_sys = False
                else:
                    sender, body, is_sys = None, rest, bool(SYSTEM_RE.search(rest))
            else:
                sender, body, is_sys = split_sender(rest, senders)
            if sender is None or is_sys or SYSTEM_RE.search(body or ""):
                last = None
                continue
            last = {"date": cur_date, "time": to_24h(tm.group(1)), "sender": sender, "text": body}
            msgs.append(last)
        elif last is not None and line.strip():
            last["text"] += "\n" + line
    return {"room": room, "messages": msgs}


# ---------------------------------------------------------------- 工具

def check_code(code: str | None):
    if ACCESS_CODE and (code or "") != ACCESS_CODE:
        raise HTTPException(403, "通行碼不正確")


def is_media(t: str) -> bool:
    t = t.strip()
    return t in MEDIA_TOKENS or (t.startswith("http") and " " not in t)


def corpus_stats(texts: list[str]) -> dict:
    emoji = Counter()
    total_len = 0
    for t in texts:
        total_len += len(t)
        for ch in t:
            if unicodedata.category(ch) == "So":
                emoji[ch] += 1
    return {
        "count": len(texts),
        "avg_len": round(total_len / max(1, len(texts)), 1),
        "top_emoji": [e for e, _ in emoji.most_common(8)],
    }


def sample_corpus(msgs: list[dict], person: str, cap_chars: int = 90_000) -> tuple[str, dict]:
    """取該人物的訊息（近期優先，保留少量最早期以見時間跨度），組成語料文本。"""
    mine = [m for m in msgs if m["sender"] == person and not is_media(m["text"])]
    if not mine:
        return "", {"count": 0}
    early = mine[:80]
    recent = mine[80:]
    # 由最近往回裝到額度滿（保留 8k 給早期樣本，讓模型看得到時間跨度）
    picked: list[dict] = []
    budget = cap_chars
    for m in reversed(recent):
        cost = len(m["text"]) + 20
        if budget - cost < 8_000:
            break
        budget -= cost
        picked.append(m)
    picked.reverse()
    early_used: list[dict] = []
    for m in early:
        cost = len(m["text"]) + 20
        if budget - cost <= 0:
            break
        budget -= cost
        early_used.append(m)

    def fmt(block: list[dict]) -> list[str]:
        out, d = [], None
        for m in block:
            if m["date"] != d:
                d = m["date"]
                out.append(f"\n## {d}")
            out.append(f"{m['time']} {m['text']}")
        return out

    parts = ["# 早期樣本"] + fmt(early_used) + ["\n# 近期語料（主體）"] + fmt(picked)
    stats = corpus_stats([m["text"] for m in mine])
    stats["span"] = f"{mine[0]['date']} ~ {mine[-1]['date']}"
    stats["sampled"] = len(early_used) + len(picked)
    return "\n".join(parts), stats


DISTILL_SYSTEM = """你是人格蒸餾師。從一個人的真實聊天發言中，提煉出可運行的「人格檔」，讓 AI 之後能以此人的口吻與思維回覆訊息。

輸出一份 markdown 人格檔，結構固定如下：

# {人名} · 人格檔
## 角色扮演規則
（以第一人稱「我」回應；免責聲明只說一次「我是{人名}的AI分身」；語料沒涵蓋的主題要標明是推斷）
## 身份卡（從語料推斷，推斷處標【推斷】）
## 表達DNA
（句式長短、開場詞、句末習慣、高頻詞、emoji/顏文字習慣、笑聲寫法、標點癖好——每一條都附語料原句為證，標日期）
## 語氣例句（10-15句最有辨識度的原句，標日期）
## 情境應對（打招呼/被問近況/約時間/聊興趣——各給貼合此人風格的範例，推斷的標【推斷】）
## 誠實邊界
（語料時間跨度與數量、哪些面向語料不足、此檔是從單一聊天室視角蒸餾的偏差）

鐵則：
- 只根據語料。沒說過的話不編造；個性推斷必須有原句支撐
- 引用原句一字不改（含錯字、注音文、emoji——這些正是指紋）
- 對方的隱私資訊（電話、地址、金額）不寫入人格檔
- 500-900行之間不限，但寧精勿濫"""

CHAT_RULES = """
--- 對話模式規則 ---
- 你現在就是這個人，以第一人稱回覆；首次回覆先說一句「我是{name}的AI分身」
- 用此人的真實說話節奏：該短就短，一個念頭可以拆多行（每行一則訊息的感覺）
- 不用 markdown、不用條列符號
- 語料沒涵蓋的事就模糊帶過或坦白說不知道，不編造
- 涉及本人隱私（行程、聯絡方式、感情）裝傻帶過"""


def sse(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


# ---------------------------------------------------------------- API

@app.get("/healthz")
def healthz():
    return {"ok": True, "model": MODEL, "personas": len(list(PERSONAS.glob("*/meta.json")))}


@app.post("/api/auth/{action}")
async def auth_proxy(action: str, payload: dict):
    if action not in {"login", "register", "refresh"}:
        raise HTTPException(404, "unknown auth action")
    try:
        r = httpx.post(f"{TF_API}/auth/{action}", json=payload, timeout=15)
    except httpx.HTTPError:
        raise HTTPException(502, "會員服務暫時沒有回應")
    return JSONResponse(r.json(), status_code=r.status_code)


@app.get("/api/auth/me")
def auth_me(authorization: str | None = Header(None)):
    user = resolve_user(authorization)
    if not user:
        raise HTTPException(401, "未登入")
    return {"id": user["id"], "email": user["email"], "username": user.get("username"),
            "team": is_team(user)}


# ---- 綠界 ECPay 儲值（測試環境預設值為官方公開測試商店）
ECPAY_MID = os.environ.get("PF_ECPAY_MID", "2000132")
ECPAY_KEY = os.environ.get("PF_ECPAY_KEY", "5294y06JbISpM5x9")
ECPAY_IV = os.environ.get("PF_ECPAY_IV", "v77hoKGq4kWxNNIS")
ECPAY_URL = os.environ.get("PF_ECPAY_URL",
    "https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5")
TOPUP_MIN, TOPUP_MAX = 1, 100000  # 下限交給綠界的卡別底線；上限僅防呆
ECPAY_DONE = DATA / "ecpay_done.json"


def _cmv(params: dict) -> str:
    import hashlib
    from urllib.parse import quote_plus
    s_ = "&".join(f"{k}={params[k]}" for k in sorted(params, key=lambda x: x.lower()))
    raw = quote_plus(f"HashKey={ECPAY_KEY}&{s_}&HashIV={ECPAY_IV}").lower()
    for a, b in (("%2d", "-"), ("%5f", "_"), ("%2e", "."), ("%21", "!"),
                 ("%2a", "*"), ("%28", "("), ("%29", ")")):
        raw = raw.replace(a, b)
    return hashlib.sha256(raw.encode()).hexdigest().upper()


@app.get("/api/wallet")
def wallet_info(authorization: str | None = Header(None)):
    user = require_user(authorization)
    return {"twd": round(wallet_get(user["id"]), 2), "margin": MARGIN,
            "twd_per_usd": TWD_PER_USD, "test_mode": ECPAY_MID == "2000132"}


@app.post("/api/topup")
def topup(payload: dict, authorization: str | None = Header(None)):
    user = require_user(authorization)
    try:
        amt = int(payload.get("amount", 0))
    except (TypeError, ValueError):
        raise HTTPException(422, "金額格式錯誤")
    if not (TOPUP_MIN <= amt <= TOPUP_MAX):
        raise HTTPException(422, f"金額限 NT${TOPUP_MIN}–{TOPUP_MAX:,}")
    order = {
        "MerchantID": ECPAY_MID,
        "MerchantTradeNo": "PF" + secrets.token_hex(8)[:14],
        "MerchantTradeDate": datetime.now(TZ).strftime("%Y/%m/%d %H:%M:%S"),
        "PaymentType": "aio",
        "TotalAmount": str(amt),
        "TradeDesc": "CopyMe wallet topup",
        "ItemName": f"CopyMe 錢包儲值 NT${amt}",
        "ReturnURL": "https://copyme.fly.dev/api/ecpay/notify",
        "ClientBackURL": "https://copyme.aiwalkcorp.com/?paid=1",
        "ChoosePayment": "Credit",
        "EncryptType": "1",
        "CustomField1": user["id"],
    }
    order["CheckMacValue"] = _cmv(order)
    fields = "".join(
        f'<input type="hidden" name="{k}" value="{v}">' for k, v in order.items())
    return {"html": f'<html><body><form id="f" method="post" action="{ECPAY_URL}">'
                    f'{fields}</form><script>document.getElementById("f").submit()'
                    f'</script></body></html>'}


@app.post("/api/ecpay/notify")
async def ecpay_notify(request: Request):
    form = dict(await request.form())
    mac = form.pop("CheckMacValue", "")
    if _cmv(form) != mac:
        return PlainTextResponse("0|CheckMacValue", status_code=400)
    if form.get("RtnCode") != "1":
        return PlainTextResponse("1|OK")
    trade = form.get("TradeNo", "")
    try:
        done = set(json.loads(ECPAY_DONE.read_text()))
    except (OSError, ValueError):
        done = set()
    if trade in done:
        return PlainTextResponse("1|OK")
    wallet_add(form.get("CustomField1", ""), float(form.get("TradeAmt", 0)))
    done.add(trade)
    ECPAY_DONE.write_text(json.dumps(sorted(done)[-500:]))
    return PlainTextResponse("1|OK")


@app.get("/api/budget")
def budget():
    return {"budget": BUDGET_USD, "spent": round(_spent(), 4),
            "remaining": round(budget_left(), 4)}


@app.get("/art/{fname}")
def art(fname: str):
    p = Path(__file__).parent / "art" / re.sub(r"[^\w.-]", "", fname)
    if not p.exists():
        raise HTTPException(404, "not found")
    mt = {"webp": "image/webp", "png": "image/png", "svg": "image/svg+xml"}.get(
        p.suffix.lstrip("."), "application/octet-stream")
    return FileResponse(p, media_type=mt)


def _threads_dir(pdir: Path) -> Path:
    d = pdir / "threads"
    d.mkdir(exist_ok=True)
    # 舊版單一 shared_chat.json → 遷移成一條討論串
    legacy = pdir / "shared_chat.json"
    if legacy.exists():
        try:
            msgs = json.loads(legacy.read_text(encoding="utf-8"))
            if msgs:
                tid = secrets.token_hex(4)
                (d / f"{tid}.json").write_text(json.dumps(
                    {"id": tid, "title": (msgs[0].get("content", "")[:24] or "討論"),
                     "msgs": msgs}, ensure_ascii=False), encoding="utf-8")
        except ValueError:
            pass
        legacy.unlink(missing_ok=True)
    return d


def _thread_list(pdir: Path) -> list[dict]:
    out = []
    for f in sorted(_threads_dir(pdir).glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            t = json.loads(f.read_text(encoding="utf-8"))
            out.append({"id": t["id"], "title": t.get("title", "討論"), "count": len(t.get("msgs", []))})
        except ValueError:
            continue
    return out[:20]


def _find_shared(token: str):
    if len(token) >= 8:
        for mp in PERSONAS.glob("*/meta.json"):
            meta = json.loads(mp.read_text(encoding="utf-8"))
            if meta.get("share") and secrets.compare_digest(meta["share"], token):
                return meta
    return None


@app.get("/s/{token}")
@app.get("/s/{token}/{slug}")
def share_landing(token: str, slug: str = ""):
    """分享連結落地頁：注入分身名稱到 title/og 讓預覽一目了然，再交給前端。"""
    from fastapi.responses import HTMLResponse, RedirectResponse
    import html as _html
    token = re.sub(r"[^\w-]", "", token)
    meta = _find_shared(token)
    if not meta:
        return RedirectResponse("/")
    name = _html.escape(meta["name"])
    page = (Path(__file__).parent / "index.html").read_text(encoding="utf-8")
    title = f"跟「{name}」的分身聊聊 · CopyMe 復刻"
    page = re.sub(r"<title>.*?</title>", f"<title>{title}</title>", page, count=1)
    inject = (
        f'<meta property="og:title" content="{title}">\n'
        f'<meta property="og:description" content="{name} 的 AI 分身——從真實對話蒸餾而成，點開直接聊。">\n'
        f'<meta property="og:image" content="https://copyme.fly.dev/art/alembic.webp">\n'
        f'<meta name="twitter:card" content="summary">\n'
        f'<base href="/">\n<script>window.__SHARE_TOKEN__="{token}"</script>\n</head>'
    )
    page = page.replace("</head>", inject, 1)
    return HTMLResponse(page)


@app.get("/api/shared/{token}/thread/{tid}")
def shared_thread(token: str, tid: str):
    for mp in PERSONAS.glob("*/meta.json"):
        meta = json.loads(mp.read_text(encoding="utf-8"))
        if meta.get("share") and secrets.compare_digest(meta["share"], token.strip()):
            f = _threads_dir(mp.parent) / f"{re.sub(r'[^a-f0-9]', '', tid)}.json"
            if not f.exists():
                raise HTTPException(404, "找不到這串討論")
            return {"msgs": json.loads(f.read_text(encoding="utf-8")).get("msgs", [])}
    raise HTTPException(404, "連結已失效")


@app.get("/")
def index():
    # no-cache：瀏覽器每次都向伺服器驗證，改版即生效（曾發生使用者卡舊快取）
    return FileResponse(Path(__file__).parent / "index.html",
                        headers={"Cache-Control": "no-cache"})


def _purge_stale_uploads() -> None:
    """一次性承諾的保險絲：沒蒸餾就離開的上傳檔，2 小時後自動清除。"""
    import time
    cutoff = time.time() - 7200
    for p in UPLOADS.glob("*.json"):
        if p.stat().st_mtime < cutoff:
            p.unlink(missing_ok=True)


def _purge_empty_personas() -> None:
    """persona.md 為空的分身無法對話（蒸餾失敗殘骸），啟動時清除。"""
    import shutil
    for pm in PERSONAS.glob("*/persona.md"):
        if pm.stat().st_size == 0:
            shutil.rmtree(pm.parent, ignore_errors=True)


_purge_empty_personas()


def _seed_demos() -> None:
    """隨映像檔內建的官方示範分身（demo/<slug>/persona.md+meta.json）：每次啟動覆寫，deploy 即更新。"""
    demo_root = Path(__file__).parent / "demo"
    if not demo_root.exists():
        return
    for mp in demo_root.glob("*/meta.json"):
        meta = json.loads(mp.read_text(encoding="utf-8"))
        pdir = PERSONAS / meta["id"]
        pdir.mkdir(parents=True, exist_ok=True)
        (pdir / "persona.md").write_text(
            (mp.parent / "persona.md").read_text(encoding="utf-8"), encoding="utf-8")
        (pdir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")


_seed_demos()


def _share_valid(token: str) -> bool:
    if len(token) < 8:
        return False
    for mp in PERSONAS.glob("*/meta.json"):
        meta = json.loads(mp.read_text(encoding="utf-8"))
        if meta.get("share") and secrets.compare_digest(meta["share"], token):
            return True
    return False


@app.post("/api/upload")
async def upload(file: UploadFile = File(...), access_code: str = Form(""),
                 share: str = Form(""),
                 authorization: str | None = Header(None)):
    check_code(access_code)
    if not _share_valid(share):  # 公開連結訪客可為擴充語料上傳
        require_user(authorization)
    _purge_stale_uploads()
    raw = (await file.read()).decode("utf-8", errors="replace")
    if len(raw) > 30_000_000:
        raise HTTPException(413, "檔案太大（上限 30MB）")
    parsed = parse_export(raw)
    msgs = parsed["messages"]
    if not msgs:
        raise HTTPException(422, "解析不到訊息——請確認是 LINE App 匯出的 .txt 聊天紀錄")
    by_sender = Counter(m["sender"] for m in msgs)
    uid = secrets.token_hex(8)
    (UPLOADS / f"{uid}.json").write_text(
        json.dumps(parsed, ensure_ascii=False), encoding="utf-8")
    people = []
    for name, cnt in by_sender.most_common(12):
        samples = [m["text"] for m in msgs
                   if m["sender"] == name and not is_media(m["text"])][-3:]
        people.append({"name": name, "count": cnt, "samples": samples})
    return {"upload_id": uid,
            "room": parsed["room"] or file.filename,
            "total": len(msgs),
            "span": f"{msgs[0]['date']} ~ {msgs[-1]['date']}",
            "people": people}


@app.post("/api/distill")
async def distill(payload: dict, authorization: str | None = Header(None)):
    check_code(payload.get("access_code"))
    user = require_user(authorization)
    check_budget(user)
    uid, person = payload.get("upload_id", ""), payload.get("person", "")
    upath = UPLOADS / f"{re.sub(r'[^a-f0-9]', '', uid)}.json"
    if not upath.exists():
        raise HTTPException(404, "找不到這筆上傳，請重新上傳檔案")
    parsed = json.loads(upath.read_text(encoding="utf-8"))
    corpus, stats = sample_corpus(parsed["messages"], person)
    if stats["count"] < 30:
        raise HTTPException(422, f"「{person}」的文字訊息只有 {stats['count']} 句，太少無法蒸餾（至少 30 句）")

    pid = secrets.token_hex(6)

    def on_done(persona_md: str) -> dict:
        pdir = PERSONAS / pid
        pdir.mkdir(parents=True, exist_ok=True)
        (pdir / "persona.md").write_text(persona_md, encoding="utf-8")
        # 保留該人物自己的發言作為分身語料庫（供日後擴充重蒸；刪除分身即一併刪除）
        mine = [m for m in parsed["messages"] if m["sender"] == person]
        (pdir / "corpus.json").write_text(json.dumps(mine, ensure_ascii=False), encoding="utf-8")
        (pdir / "meta.json").write_text(json.dumps({
            "id": pid, "name": person, "room": parsed["room"],
            "stats": stats,
            "owner_id": user["id"], "owner_email": user["email"],
            "demo": is_team(user),
            "created": datetime.now(TZ).isoformat(timespec="seconds"),
        }, ensure_ascii=False), encoding="utf-8")
        upath.unlink(missing_ok=True)  # 一次性承諾：蒸餾完成，原始對話檔立即刪除
        return {"persona_id": pid, "name": person}

    return _detached_sse(_distill_events(person, parsed["room"], corpus, stats, on_done, bill_user=user))


def _detached_sse(events) -> StreamingResponse:
    """在背景執行緒跑完整個事件流：手機切出去斷線，蒸餾照樣完成並存檔。"""
    import queue, threading
    q: queue.Queue = queue.Queue()

    def work():
        try:
            for ev in events:
                q.put(ev)
        except Exception as e:  # 背景執行緒的最後防線，錯誤轉成 SSE 事件
            import traceback; traceback.print_exc()
            q.put(sse("error", {"message": f"蒸餾中斷：{e}"}))
        q.put(None)

    threading.Thread(target=work, daemon=True).start()

    def gen():
        while (item := q.get()) is not None:
            yield item

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache"})


def _distill_events(person: str, room: str, corpus: str, stats: dict, on_done, bill_user=None):
    """共用蒸餾串流：yield SSE 事件，成功時呼叫 on_done(persona_md) 取得 done 載荷。"""
    yield sse("status", {"stage": "start", "stats": stats})
    prompt = (
        f"人名：{person}\n聊天室：{room or '（未知）'}\n"
        f"語料統計：共 {stats['count']} 句（本次取樣 {stats['sampled']} 句），"
        f"時間跨度 {stats['span']}，平均 {stats['avg_len']} 字/句，"
        f"常用 emoji：{''.join(stats['top_emoji']) or '無'}\n\n"
        f"以下是他/她的發言語料：\n\n{corpus}"
    )
    import time
    chunks: list[str] = []
    final = None
    for attempt in range(4):
        chunks.clear()
        use_model = MODEL if attempt < 3 else FALLBACK_MODEL
        try:
            with claude.messages.stream(
                model=use_model,
                max_tokens=16000,
                output_config={"effort": "medium"},
                system=DISTILL_SYSTEM,
                messages=[{"role": "user", "content": prompt}],
            ) as stream:
                for text in stream.text_stream:
                    chunks.append(text)
                    yield sse("delta", {"text": text})
                final = stream.get_final_message()
            break
        except anthropic.AnthropicError as e:
            status = getattr(e, "status_code", 0) or 0
            txt = str(getattr(e, "message", "") or e).lower()
            print(f"[distill] {person} attempt {attempt+1} model={use_model} "
                  f"status={status} err={txt[:200]}", flush=True)
            transient = (status in (429, 500, 529)
                         or isinstance(e, anthropic.APIConnectionError)
                         or "overloaded" in txt or "rate limit" in txt or "timeout" in txt)
            if transient and attempt < 3:
                wait = (7, 15, 30)[attempt]
                note = (f"模型壅塞，{wait} 秒後自動重試（{attempt+2}/4）…" if attempt < 2
                        else f"主模型持續壅塞，{wait} 秒後改用備援模型完成這次蒸餾…")
                yield sse("status", {"stage": "retry", "message": note})
                time.sleep(wait)
                continue
            msg = "模型目前壅塞，已重試多次仍失敗——語料還在，稍等一兩分鐘再按一次就好" if transient                   else f"Claude API 錯誤：{getattr(e, 'message', e)}"
            yield sse("error", {"message": msg})
            return
    track_usage(final.usage, user=bill_user, model=use_model)
    if final.stop_reason == "refusal":
        yield sse("error", {"message": "這份語料被安全機制擋下，無法蒸餾"})
        return
    persona_md = "".join(chunks)
    if not persona_md.strip():
        yield sse("error", {"message": "蒸餾結果是空的（模型沒有產出文字），請再按一次重新蒸餾"})
        return
    yield sse("done", on_done(persona_md))


@app.post("/api/distill/extend")
async def distill_extend(payload: dict, authorization: str | None = Header(None)):
    """擴充語料：擁有者或公開連結訪客丟新 txt，合併去重後重蒸同一個分身。"""
    ext_user = resolve_user(authorization)
    check_budget(ext_user)
    pid = re.sub(r"[^a-f0-9]", "", payload.get("persona_id", ""))
    pdir = PERSONAS / pid
    if not (pdir / "meta.json").exists():
        raise HTTPException(404, "找不到這個分身")
    meta = json.loads((pdir / "meta.json").read_text(encoding="utf-8"))
    share_tok = str(payload.get("share") or "")
    share_ok = bool(share_tok and meta.get("share")
                    and secrets.compare_digest(meta["share"], share_tok))
    user = ext_user
    if not share_ok and not (user and meta.get("owner_id") == user.get("id")):
        raise HTTPException(403, "只有擁有者或持公開連結者能擴充語料")

    uid, person = payload.get("upload_id", ""), payload.get("person", "")
    upath = UPLOADS / f"{re.sub(r'[^a-f0-9]', '', uid)}.json"
    if not upath.exists():
        raise HTTPException(404, "找不到這筆上傳，請重新上傳檔案")
    parsed = json.loads(upath.read_text(encoding="utf-8"))
    new_msgs = [m for m in parsed["messages"] if m["sender"] == person]
    if not new_msgs:
        raise HTTPException(422, f"這份檔案裡找不到「{person}」的發言")

    name = meta["name"]
    cpath = pdir / "corpus.json"
    old = json.loads(cpath.read_text(encoding="utf-8")) if cpath.exists() else []
    seen = {(m.get("date"), m["text"]) for m in old}
    added = [{**m, "sender": name} for m in new_msgs
             if (m.get("date"), m["text"]) not in seen]
    merged = old + added
    corpus, stats = sample_corpus(merged, name)
    if stats["count"] < 30:
        raise HTTPException(422, f"合併後只有 {stats['count']} 句文字訊息，太少無法蒸餾（至少 30 句）")

    def on_done(persona_md: str) -> dict:
        (pdir / "persona.md").write_text(persona_md, encoding="utf-8")
        cpath.write_text(json.dumps(merged, ensure_ascii=False), encoding="utf-8")
        meta["stats"] = stats
        meta["updated"] = datetime.now(TZ).isoformat(timespec="seconds")
        (pdir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        upath.unlink(missing_ok=True)  # 一次性承諾不變：整份聊天檔用完即刪
        return {"persona_id": pid, "name": name, "added": len(added), "stats": stats}

    return _detached_sse(_distill_events(name, meta.get("room", ""), corpus, stats, on_done, bill_user=ext_user))


def _visible(meta: dict, user) -> bool:
    if meta.get("demo"):
        return True
    return bool(user) and meta.get("owner_id") == user.get("id")


@app.get("/api/personas")
def list_personas(authorization: str | None = Header(None)):
    user = resolve_user(authorization)
    out = []
    for mp in sorted(PERSONAS.glob("*/meta.json"),
                     key=lambda p: p.stat().st_mtime, reverse=True):
        meta = json.loads(mp.read_text(encoding="utf-8"))
        if _visible(meta, user):
            mine = bool(user) and meta.get("owner_id") == user.get("id")
            meta.pop("owner_id", None); meta.pop("owner_email", None)
            if not mine:
                meta.pop("share", None)  # 分享 token 只有擁有者看得到
            meta["mine"] = mine
            out.append(meta)
    return {"personas": out}


@app.get("/api/personas/{pid}")
def get_persona(pid: str, authorization: str | None = Header(None)):
    pdir = PERSONAS / re.sub(r"[^a-f0-9]", "", pid)
    if not (pdir / "meta.json").exists():
        raise HTTPException(404, "找不到這個人格")
    meta = json.loads((pdir / "meta.json").read_text(encoding="utf-8"))
    if not _visible(meta, resolve_user(authorization)):
        raise HTTPException(403, "這個分身不是公開示範，只有本人看得到")
    return {"meta": meta, "persona": (pdir / "persona.md").read_text(encoding="utf-8")}


@app.post("/api/personas/{pid}/delete")
def delete_persona(pid: str, payload: dict, authorization: str | None = Header(None)):
    """分身可隨時刪除：僅擁有者本人。"""
    check_code(payload.get("access_code"))
    user = require_user(authorization)
    import shutil
    pdir = PERSONAS / re.sub(r"[^a-f0-9]", "", pid)
    if not (pdir / "meta.json").exists():
        raise HTTPException(404, "找不到這個分身")
    meta = json.loads((pdir / "meta.json").read_text(encoding="utf-8"))
    if meta.get("owner_id") != user.get("id"):
        raise HTTPException(403, "只有擁有者能刪除這個分身")
    shutil.rmtree(pdir)
    return {"deleted": True}


@app.post("/api/personas/{pid}/avatar")
async def set_avatar(pid: str, file: UploadFile = File(...),
                     authorization: str | None = Header(None)):
    """分身頭貼（選填）：僅擁有者。有頭貼時前端以照片取代文字印章。"""
    user = require_user(authorization)
    pdir = PERSONAS / re.sub(r"[^a-f0-9]", "", pid)
    if not (pdir / "meta.json").exists():
        raise HTTPException(404, "找不到這個分身")
    meta = json.loads((pdir / "meta.json").read_text(encoding="utf-8"))
    if meta.get("owner_id") != user.get("id"):
        raise HTTPException(403, "只有擁有者能設定頭貼")
    if not (file.content_type or "").startswith("image/"):
        raise HTTPException(422, "請上傳圖片檔")
    raw = await file.read()
    if len(raw) > 2_000_000:
        raise HTTPException(413, "圖片太大（上限 2MB）")
    (pdir / "avatar").write_bytes(raw)
    meta["avatar"] = f"api/personas/{meta['id']}/avatar"
    meta["avatar_ct"] = file.content_type
    (pdir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    return {"avatar": meta["avatar"]}


@app.get("/api/personas/{pid}/avatar")
def get_avatar(pid: str):
    pdir = PERSONAS / re.sub(r"[^a-f0-9]", "", pid)
    f = pdir / "avatar"
    if not f.exists():
        raise HTTPException(404, "no avatar")
    ct = "image/webp"
    try:
        ct = json.loads((pdir / "meta.json").read_text(encoding="utf-8")).get("avatar_ct") or ct
    except (OSError, ValueError):
        pass
    return FileResponse(f, media_type=ct)


@app.post("/api/personas/{pid}/share")
def share_persona(pid: str, payload: dict, authorization: str | None = Header(None)):
    """公開連結開關：僅擁有者。token 即訪問能力，停用即失效。"""
    user = require_user(authorization)
    pdir = PERSONAS / re.sub(r"[^a-f0-9]", "", pid)
    if not (pdir / "meta.json").exists():
        raise HTTPException(404, "找不到這個分身")
    mpath = pdir / "meta.json"
    meta = json.loads(mpath.read_text(encoding="utf-8"))
    if meta.get("owner_id") != user.get("id"):
        raise HTTPException(403, "只有擁有者能開關公開連結")
    if payload.get("enable"):
        meta["share"] = meta.get("share") or secrets.token_urlsafe(9)
    else:
        meta.pop("share", None)
        (pdir / "shared_chat.json").unlink(missing_ok=True)
        import shutil
        shutil.rmtree(pdir / "threads", ignore_errors=True)
    mpath.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    return {"share": meta.get("share")}


@app.get("/api/shared/{token}")
def shared_info(token: str):
    """憑分享 token 取得分身基本資訊（免登入）。"""
    token = token.strip()
    if len(token) >= 8:
        for mp in PERSONAS.glob("*/meta.json"):
            meta = json.loads(mp.read_text(encoding="utf-8"))
            if meta.get("share") and secrets.compare_digest(meta["share"], token):
                return {"id": meta["id"], "name": meta["name"],
                        "room": meta.get("room", ""), "stats": meta.get("stats", {}),
                        "threads": _thread_list(mp.parent)}
    raise HTTPException(404, "連結已失效或被擁有者停用")


GUEST_MSG_CAP = int(os.environ.get("PF_GUEST_MSG_CAP", "3"))
GUEST_FILE = DATA / "guest_counts.json"


def check_guest_cap(request: Request) -> None:
    """未登入玩示範分身：每 IP 每天 3 則免費，之後引導註冊。"""
    ip = request.headers.get("fly-client-ip") or (request.client.host if request.client else "?")
    today = datetime.now(TZ).strftime("%Y-%m-%d")
    try:
        counts = json.loads(GUEST_FILE.read_text())
    except (OSError, ValueError):
        counts = {}
    if counts.get("_date") != today:
        counts = {"_date": today}
    used = counts.get(ip, 0)
    if used >= GUEST_MSG_CAP:
        raise HTTPException(402, f"免費體驗 {GUEST_MSG_CAP} 則已用完——註冊登入就能繼續聊，還能蒸一個你自己的分身")
    counts[ip] = used + 1
    GUEST_FILE.write_text(json.dumps(counts))


@app.post("/api/chat")
async def chat(payload: dict, request: Request, authorization: str | None = Header(None)):
    check_code(payload.get("access_code"))
    bill_user = resolve_user(authorization)
    check_budget(bill_user)
    if bill_user is None and not payload.get("share"):
        check_guest_cap(request)
    pid = re.sub(r"[^a-f0-9]", "", payload.get("persona_id", ""))
    pdir = PERSONAS / pid
    if not (pdir / "persona.md").exists():
        raise HTTPException(404, "找不到這個人格，請先蒸餾")
    persona_text = (pdir / "persona.md").read_text(encoding="utf-8")
    if not persona_text.strip():
        raise HTTPException(409, "這個分身的人格檔是空的（先前蒸餾失敗），請刪除後重新蒸餾")
    meta = json.loads((pdir / "meta.json").read_text(encoding="utf-8"))
    share_tok = str(payload.get("share") or "")
    share_ok = bool(share_tok and meta.get("share")
                    and secrets.compare_digest(meta["share"], share_tok))
    if not share_ok and not _visible(meta, bill_user):
        raise HTTPException(403, "這個分身不是公開示範，只有本人能對話")
    history = payload.get("messages", [])[-40:]
    if not history or history[-1].get("role") != "user":
        raise HTTPException(422, "缺少使用者訊息")
    system = [
        {"type": "text",
         "text": persona_text,
         "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": CHAT_RULES.replace("{name}", meta["name"])},
    ]

    remember = bool(payload.get("remember")) and share_ok
    req_tid = re.sub(r"[^a-f0-9]", "", str(payload.get("thread") or ""))
    primary = {"opus": MODEL, "sonnet": FALLBACK_MODEL}.get(
        str(payload.get("model") or ""), MODEL)

    def gen():
      for use_model in (primary, FALLBACK_MODEL):
        chunks: list[str] = []
        try:
            with claude.messages.stream(
                model=use_model,
                max_tokens=800,
                output_config={"effort": "low"},
                system=system,
                messages=[{"role": m["role"], "content": m["content"]} for m in history],
            ) as stream:
                for text in stream.text_stream:
                    chunks.append(text)
                    yield sse("delta", {"text": text})
                final = stream.get_final_message()
            track_usage(final.usage, user=bill_user, model=use_model)
            if final.stop_reason == "refusal":
                yield sse("delta", {"text": "（這題我不方便回）"})
        except anthropic.AnthropicError as e:
            txt = str(getattr(e, "message", "") or e).lower()
            transient = (getattr(e, "status_code", 0) in (429, 529)
                         or "overloaded" in txt or "rate limit" in txt)
            if transient and use_model == MODEL and not chunks:
                continue  # 主模型壅塞且尚未輸出 → 換備援模型重打
            if transient:
                yield sse("error", {"message": "模型目前壅塞，稍等幾秒再送一次"})
            else:
                yield sse("error", {"message": f"Claude API 錯誤：{getattr(e, 'message', e)}"})
            return
        tid_out = ""
        if remember and chunks:
            # ponytail: 整檔重寫，單機小流量夠用；量大再換 append log
            d = _threads_dir(pdir)
            tid_out = req_tid or secrets.token_hex(4)
            f = d / f"{tid_out}.json"
            try:
                t = json.loads(f.read_text(encoding="utf-8")) if f.exists() else None
            except ValueError:
                t = None
            if t is None:
                t = {"id": tid_out,
                     "title": history[-1].get("content", "")[:24] or "討論", "msgs": []}
            t["msgs"] = (t["msgs"] + [history[-1],
                {"role": "assistant", "content": "".join(chunks)}])[-200:]
            f.write_text(json.dumps(t, ensure_ascii=False), encoding="utf-8")
        yield sse("done", {"thread": tid_out})
        return

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache"})
