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

# ---- 計費參數可在 /data/billing.json 動態覆寫（官方價目會變動，不必重新部署）
BILLING_FILE = DATA / "billing.json"
USAGE_LOG = DATA / "usage.jsonl"


def _billing() -> dict:
    try:
        return json.loads(BILLING_FILE.read_text())
    except (OSError, ValueError):
        return {}


def cur_margin() -> float:
    return float(_billing().get("margin", MARGIN))


def cur_rate() -> float:
    return float(_billing().get("twd_per_usd", TWD_PER_USD))


def cur_prices() -> dict:
    p = dict(_PRICES)
    for k, v in _billing().get("prices", {}).items():
        if isinstance(v, dict) and "in" in v and "out" in v:
            p[k] = {"in": float(v["in"]), "out": float(v["out"])}
    return p


def _log_usage(usage, model: str | None, usd: float, twd: float, src: str, uid: str | None):
    """每次模型呼叫記一行 JSONL：實際成本 vs 實收台幣，供 /api/admin/billing 分析。"""
    try:
        row = {
            "ts": datetime.now(TZ).isoformat(timespec="seconds"),
            "model": model or MODEL,
            "in": usage.input_tokens,
            "out": usage.output_tokens,
            "cw": getattr(usage, "cache_creation_input_tokens", 0) or 0,
            "cr": getattr(usage, "cache_read_input_tokens", 0) or 0,
            "usd": round(usd, 6),
            "twd": round(twd, 4),
            "src": src,  # wallet / pool / ink / fuel
            "uid": uid,
        }
        with USAGE_LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except OSError:
        pass


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


def _usd(usage, model: str | None = None) -> float:
    prices = cur_prices()
    p = prices.get(model or MODEL, prices["claude-opus-5"])
    return (
        usage.input_tokens * p["in"]
        + usage.output_tokens * p["out"]
        + (getattr(usage, "cache_creation_input_tokens", 0) or 0) * p["in"] * 1.25
        + (getattr(usage, "cache_read_input_tokens", 0) or 0) * p["in"] * 0.1
    ) / 1e6


def track_usage(usage, user=None, model: str | None = None) -> float:
    """記帳並回傳這次呼叫的 USD 成本（供群組燃料等額度機制使用）。"""
    cost = _usd(usage, model)
    # 登入且錢包有餘額 → 扣個人錢包（成本×毛利倍率×匯率）；否則吃站方體驗池
    if user and wallet_get(user["id"]) > 0:
        twd = cost * cur_margin() * cur_rate()
        wallet_add(user["id"], -twd)
        _log_usage(usage, model, cost, twd, "wallet", user["id"])
        return cost
    tmp = SPEND_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"usd": _spent() + cost}))
    tmp.replace(SPEND_FILE)
    _log_usage(usage, model, cost, 0.0, "pool", user["id"] if user else None)
    return cost


def budget_left() -> float:
    return max(0.0, BUDGET_USD - _spent())


DISTILL_MIN_TWD = float(os.environ.get("PF_DISTILL_MIN_TWD", "25"))


def check_distill_budget(user=None) -> None:
    """蒸餾成本約 NT$19–24 且為事後扣款——先擋餘額不足，避免透支成負數。"""
    if user and not is_team(user) and wallet_get(user["id"]) < DISTILL_MIN_TWD:
        raise HTTPException(402, f"蒸餾一次約需 NT${DISTILL_MIN_TWD:.0f}，"
                                 f"目前額度 NT${wallet_get(user['id']):.2f} 不足，請先加購對話包")


def check_budget(user=None) -> None:
    if user and wallet_get(user["id"]) > 0:
        return
    if budget_left() <= 0:
        raise HTTPException(402, "站方體驗額度用完了——登入後加購對話包即可繼續，或晚點再來！")

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
    _welcome_credit(user)
    return user


WELCOME_TWD = float(os.environ.get("PF_WELCOME_TWD", "10"))


def _welcome_credit(user) -> None:
    """帳戶第一次出現（還沒有錢包檔）就送迎新額度，取代共用體驗池的角色。"""
    uid = user.get("id")
    _wallet_index(uid, user.get("email"), user.get("username"))
    if not uid or WELCOME_TWD <= 0 or _wpath(uid).exists():
        return
    wallet_add(uid, WELCOME_TWD)


WALLET_INDEX = WALLETS / "_index.json"


def _wallet_index(uid, email=None, username=None) -> dict:
    """uid ↔ email/username 對照表（管理面加值、報表辨識用）。"""
    try:
        idx = json.loads(WALLET_INDEX.read_text())
    except (OSError, ValueError):
        idx = {}
    if uid and (email or username):
        row = {"email": email or "", "username": username or ""}
        if idx.get(uid) != row:
            idx[uid] = row
            WALLET_INDEX.write_text(json.dumps(idx, ensure_ascii=False))
    return idx


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
    # iOS 版匯出常見差異：BOM 開頭、NBSP／全形空格當分隔符 → 先正規化成一般空格
    text = text.lstrip("﻿").replace(" ", " ").replace("　", " ")
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
TOPUP_MIN, TOPUP_MAX = 5, 100000  # 綠界信用卡單筆最低 NT$5——低於它付款頁會空（錯誤 10300023）
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


# ---- 非信用卡「幕後取號」：站內顯示 ATM 虛擬帳號／超商代碼，不跳綠界頁。
# 傳輸格式：JSON + AES-128-CBC(PKCS7)，明文先 URLEncode 再加密（官方規格）
ECPAY_GEN_URL = os.environ.get("PF_ECPAY_GEN_URL",
    ("https://ecpayment-stage.ecpay.com.tw/1.0.0/Cashier/GenPaymentCode"
     if ECPAY_MID == "2000132" else
     "https://ecpayment.ecpay.com.tw/1.0.0/Cashier/GenPaymentCode"))
ECPAY_ORDERS = DATA / "ecpay_orders"
ECPAY_ORDERS.mkdir(parents=True, exist_ok=True)


def _ec_aes(data: bytes, encrypt: bool) -> bytes:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives import padding
    c = Cipher(algorithms.AES(ECPAY_KEY.encode()[:16]), modes.CBC(ECPAY_IV.encode()[:16]))
    if encrypt:
        p = padding.PKCS7(128).padder()
        data = p.update(data) + p.finalize()
        e = c.encryptor()
        return e.update(data) + e.finalize()
    d = c.decryptor()
    out = d.update(data) + d.finalize()
    u = padding.PKCS7(128).unpadder()
    return u.update(out) + u.finalize()


def _ec_encrypt(obj: dict) -> str:
    import base64
    from urllib.parse import quote
    plain = quote(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), safe="")
    return base64.b64encode(_ec_aes(plain.encode(), True)).decode()


def _ec_decrypt(s: str) -> dict:
    import base64
    from urllib.parse import unquote_plus
    return json.loads(unquote_plus(_ec_aes(base64.b64decode(s), False).decode()))


@app.get("/api/wallet")
def wallet_info(authorization: str | None = Header(None)):
    user = require_user(authorization)
    return {"twd": round(wallet_get(user["id"]), 2), "margin": cur_margin(),
            "twd_per_usd": cur_rate(), "test_mode": ECPAY_MID == "2000132"}


def _usage_stats() -> dict:
    """讀 usage.jsonl 彙總 24h / 7d / 全期：token 量、實際 USD 成本、實收 TWD、有效倍率。"""
    now = datetime.now(TZ)
    wins = {"24h": now - timedelta(hours=24), "7d": now - timedelta(days=7), "all": None}
    agg = {k: {"calls": 0, "in": 0, "out": 0, "cw": 0, "cr": 0,
               "usd": 0.0, "twd": 0.0, "twd_free": 0.0} for k in wins}
    try:
        with USAGE_LOG.open(encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                    ts = datetime.fromisoformat(r["ts"])
                except (ValueError, KeyError):
                    continue
                for k, since in wins.items():
                    if since is not None and ts < since:
                        continue
                    a = agg[k]
                    a["calls"] += 1
                    for fld in ("in", "out", "cw", "cr"):
                        a[fld] += r.get(fld, 0)
                    a["usd"] += r.get("usd", 0.0)
                    if r.get("src") == "pool":
                        a["twd_free"] += r.get("usd", 0.0) * cur_rate()
                    else:
                        a["twd"] += r.get("twd", 0.0)
    except OSError:
        pass
    for a in agg.values():
        billed_usd_equiv = a["twd"] / cur_rate() if a["twd"] else 0.0
        paid_usd = a["usd"] - (a["twd_free"] / cur_rate())  # 扣掉免費池吃掉的成本
        a["eff_margin"] = round(billed_usd_equiv / paid_usd, 3) if paid_usd > 0.005 else None
        a["usd"] = round(a["usd"], 4)
        a["twd"] = round(a["twd"], 2)
        a["twd_free"] = round(a["twd_free"], 2)
    return agg


@app.get("/api/admin/billing")
def admin_billing(authorization: str | None = Header(None)):
    user = require_user(authorization)
    if not is_team(user):
        raise HTTPException(403, "團隊限定")
    stats = _usage_stats()
    idx = _wallet_index(None)
    wallets = {}
    for p in WALLETS.glob("*.json"):
        if p.name.startswith("_"):
            continue
        try:
            who = idx.get(p.stem, {})
            label = who.get("username") or who.get("email") or p.stem
            wallets[label] = json.loads(p.read_text())["twd"]
        except (OSError, ValueError, KeyError):
            pass
    total_wallet = round(sum(wallets.values()), 2)
    day = stats["7d"]
    burn_twd_day = round((day["twd"] + day["twd_free"]) / 7, 2)
    burn_usd_day = round(day["usd"] / 7, 4)
    return {
        "params": {"margin": cur_margin(), "twd_per_usd": cur_rate(),
                   "prices": cur_prices(),
                   "overrides": _billing()},   # billing.json 目前的覆寫內容
        "pool": {"budget_usd": BUDGET_USD, "spent_usd": round(_spent(), 4),
                 "left_usd": round(budget_left(), 4)},
        "wallets": {"total_twd": total_wallet, "by_user": wallets},
        "usage": stats,
        "burn": {"twd_per_day": burn_twd_day, "usd_per_day": burn_usd_day,
                 "wallet_runway_days": (round(total_wallet / burn_twd_day, 1)
                                        if burn_twd_day > 0 else None),
                 "pool_runway_days": (round(budget_left() / burn_usd_day, 1)
                                      if burn_usd_day > 0 else None)},
    }


@app.post("/api/admin/credit")
def admin_credit(payload: dict, authorization: str | None = Header(None)):
    """管理面加值：帶 uid 或 email/username（查 _index 對照）＋ twd 金額（可負值扣回）。"""
    user = require_user(authorization)
    if not is_team(user):
        raise HTTPException(403, "團隊限定")
    try:
        twd = float(payload.get("twd"))
    except (TypeError, ValueError):
        raise HTTPException(422, "twd 金額格式錯誤")
    if not (-100000 <= twd <= 100000):
        raise HTTPException(422, "金額超出範圍")
    uid = payload.get("uid") or ""
    if not uid:
        key = (payload.get("email") or payload.get("username") or "").strip().lower()
        if not key:
            raise HTTPException(422, "要帶 uid 或 email/username")
        matches = [u for u, who in _wallet_index(None).items()
                   if key in (who.get("email", "").lower(), who.get("username", "").lower())]
        if not matches:
            raise HTTPException(404, "對照表找不到這個人——請對方先登入 CopyMe 一次")
        if len(matches) > 1:
            raise HTTPException(409, f"對到多個帳戶：{matches}")
        uid = matches[0]
    bal = wallet_add(uid, twd)
    return {"ok": True, "uid": uid, "twd_added": twd, "balance": round(bal, 2)}


@app.post("/api/admin/billing")
def admin_billing_set(payload: dict, authorization: str | None = Header(None)):
    """動態調整計費參數（margin / twd_per_usd / prices），寫入 volume 即刻生效。"""
    user = require_user(authorization)
    if not is_team(user):
        raise HTTPException(403, "團隊限定")
    cfg = _billing()
    if "margin" in payload:
        m = float(payload["margin"])
        if not (1.0 <= m <= 10.0):
            raise HTTPException(422, "margin 限 1.0–10.0（低於 1 會虧本）")
        cfg["margin"] = m
    if "twd_per_usd" in payload:
        r = float(payload["twd_per_usd"])
        if not (20.0 <= r <= 50.0):
            raise HTTPException(422, "twd_per_usd 限 20–50")
        cfg["twd_per_usd"] = r
    if "prices" in payload:
        if not isinstance(payload["prices"], dict):
            raise HTTPException(422, "prices 要是 {model: {in, out}} 格式")
        for k, v in payload["prices"].items():
            if not (isinstance(v, dict) and "in" in v and "out" in v):
                raise HTTPException(422, f"prices[{k}] 缺 in/out")
        cfg["prices"] = payload["prices"]
    if payload.get("reset"):
        cfg = {}
    tmp = BILLING_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, ensure_ascii=False))
    tmp.replace(BILLING_FILE)
    return {"ok": True, "margin": cur_margin(), "twd_per_usd": cur_rate(),
            "prices": cur_prices()}


@app.post("/api/topup")
def topup(payload: dict, authorization: str | None = Header(None)):
    """儲值錢包；帶 ink=<pid> 則改注入該分身公開連結的「連結墨水」（訪客對話優先燒它）。"""
    user = require_user(authorization)
    try:
        amt = int(payload.get("amount", 0))
    except (TypeError, ValueError):
        raise HTTPException(422, "金額格式錯誤")
    if not (TOPUP_MIN <= amt <= TOPUP_MAX):
        raise HTTPException(422, f"金額限 NT${TOPUP_MIN}–{TOPUP_MAX:,}")
    ink_pid = re.sub(r"[^a-f0-9]", "", str(payload.get("ink") or ""))
    if ink_pid:
        mp = PERSONAS / ink_pid / "meta.json"
        if not mp.exists():
            raise HTTPException(404, "找不到這個分身")
        if json.loads(mp.read_text(encoding="utf-8")).get("owner_id") != user["id"]:
            raise HTTPException(403, "只有擁有者能注入連結墨水")
    order = {
        "MerchantID": ECPAY_MID,
        "MerchantTradeNo": "PF" + secrets.token_hex(8)[:14],
        "MerchantTradeDate": datetime.now(TZ).strftime("%Y/%m/%d %H:%M:%S"),
        "PaymentType": "aio",
        "TotalAmount": str(amt),
        "TradeDesc": "CopyMe link ink" if ink_pid else "CopyMe chat pack",
        "ItemName": (f"CopyMe 連結墨水 NT${amt}" if ink_pid else f"CopyMe 對話包 NT${amt}"),
        "ReturnURL": "https://copyme.fly.dev/api/ecpay/notify",
        "ClientBackURL": "https://copyme.aiwalkcorp.com/?paid=1",
        # ALL＝顯示商店當下已開通的全部付款方式。新綠界商店的信用卡要另外申請，
        # 審核期間指定 Credit 會變成「無任何付款方式」（10300023）
        "ChoosePayment": os.environ.get("PF_ECPAY_PAY", "ALL"),
        "EncryptType": "1",
        "CustomField1": user["id"],
        "CustomField2": ink_pid,
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
    ink_pid = re.sub(r"[^a-f0-9]", "", form.get("CustomField2", "") or "")
    amt = float(form.get("TradeAmt", 0))
    mp = PERSONAS / ink_pid / "meta.json" if ink_pid else None
    if mp and mp.exists():
        meta = json.loads(mp.read_text(encoding="utf-8"))
        meta["ink_twd"] = round(meta.get("ink_twd", 0.0) + amt, 2)
        mp.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    else:
        wallet_add(form.get("CustomField1", ""), amt)
    done.add(trade)
    ECPAY_DONE.write_text(json.dumps(sorted(done)[-500:]))
    return PlainTextResponse("1|OK")


@app.post("/api/topup/inline")
def topup_inline(payload: dict, authorization: str | None = Header(None)):
    """幕後取號：站內取得 ATM 虛擬帳號或超商繳費代碼，付款畫面全程不離站。"""
    import time
    user = require_user(authorization)
    try:
        amt = int(payload.get("amount", 0))
    except (TypeError, ValueError):
        raise HTTPException(422, "金額格式錯誤")
    if not (TOPUP_MIN <= amt <= TOPUP_MAX):
        raise HTTPException(422, f"金額限 NT${TOPUP_MIN}–{TOPUP_MAX:,}")
    method = payload.get("method")
    if method not in ("ATM", "CVS"):
        raise HTTPException(422, "method 要是 ATM 或 CVS")
    tno = "PF" + secrets.token_hex(8)[:14]
    inner = {
        "MerchantID": ECPAY_MID,
        "ChoosePayment": method,
        "OrderInfo": {
            "MerchantTradeNo": tno,
            "MerchantTradeDate": datetime.now(TZ).strftime("%Y/%m/%d %H:%M:%S"),
            "TotalAmount": amt,
            "ReturnURL": "https://copyme.fly.dev/api/ecpay/notify2",
            "TradeDesc": "CopyMe chat pack",
            "ItemName": f"CopyMe 對話包 NT${amt}",
        },
    }
    if method == "ATM":
        inner["ATMInfo"] = {"ExpireDate": 3}            # 天
    else:
        inner["CVSInfo"] = {"ExpireDate": 4320}         # 分鐘＝3 天
    body = {"MerchantID": ECPAY_MID,
            "RqHeader": {"Timestamp": int(time.time())},
            "Data": _ec_encrypt(inner)}
    try:
        r = httpx.post(ECPAY_GEN_URL, json=body, timeout=20)
        rj = r.json()
    except (httpx.HTTPError, ValueError):
        raise HTTPException(502, "綠界服務沒有回應，請改用「其他付款方式」")
    if rj.get("TransCode") != 1:
        raise HTTPException(502, f"綠界拒絕了請求：{rj.get('TransMsg', '未知錯誤')}")
    data = _ec_decrypt(rj["Data"])
    if data.get("RtnCode") != 1:
        raise HTTPException(502, f"取號失敗：{data.get('RtnMsg', '未知錯誤')}")
    # 訂單歸屬存檔，付款通知進來時據此入帳
    (ECPAY_ORDERS / f"{tno}.json").write_text(json.dumps({
        "uid": user["id"], "amt": amt,
        "ink_pid": re.sub(r"[^a-f0-9]", "", str(payload.get("ink") or "")),
        "trade_no": data.get("OrderInfo", {}).get("TradeNo", ""),
        "created": datetime.now(TZ).isoformat(timespec="seconds"),
    }, ensure_ascii=False))
    atm, cvs = data.get("ATMInfo") or {}, data.get("CVSInfo") or {}
    return {"trade": tno, "method": method, "amount": amt,
            "bank_code": atm.get("BankCode"), "v_account": atm.get("vAccount"),
            "payment_no": cvs.get("PaymentNo"), "payment_url": cvs.get("PaymentURL"),
            "expire": atm.get("ExpireDate") or cvs.get("ExpireDate")}


@app.post("/api/ecpay/notify2")
async def ecpay_notify2(request: Request):
    """幕後取號流程的付款結果通知（JSON+AES 版；與表單版 notify 分開）。"""
    try:
        body = json.loads((await request.body()).decode())
        data = _ec_decrypt(body["Data"])
    except (ValueError, KeyError):
        return PlainTextResponse("0|DecryptFail", status_code=400)
    info = data.get("OrderInfo") or {}
    tno = re.sub(r"[^\w]", "", str(info.get("MerchantTradeNo") or ""))
    paid = str(info.get("TradeStatus")) == "1" or data.get("RtnCode") == 1
    opath = ECPAY_ORDERS / f"{tno}.json"
    if not (paid and tno and opath.exists()):
        return PlainTextResponse("1|OK")
    trade = str(info.get("TradeNo") or tno)
    try:
        done = set(json.loads(ECPAY_DONE.read_text()))
    except (OSError, ValueError):
        done = set()
    if trade in done:
        return PlainTextResponse("1|OK")
    order = json.loads(opath.read_text())
    amt = float(info.get("TradeAmt") or order["amt"])
    mp = PERSONAS / order["ink_pid"] / "meta.json" if order.get("ink_pid") else None
    if mp and mp.exists():
        meta = json.loads(mp.read_text(encoding="utf-8"))
        meta["ink_twd"] = round(meta.get("ink_twd", 0.0) + amt, 2)
        mp.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    else:
        wallet_add(order["uid"], amt)
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
            out.append({"id": t["id"], "title": t.get("title", "討論"), "count": len(t.get("msgs", [])),
                        "mtime": datetime.fromtimestamp(f.stat().st_mtime, TZ).strftime("%m/%d")})
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


def _find_shared_room(token: str):
    if len(token) >= 8:
        for f in ROOMS.glob("*.json"):
            try:
                room = json.loads(f.read_text(encoding="utf-8"))
            except ValueError:
                continue
            if room.get("share") and secrets.compare_digest(room["share"], token):
                return room
    return None


@app.get("/s/{token}")
@app.get("/s/{token}/{slug}")
def share_landing(token: str, slug: str = ""):
    """分享連結落地頁：注入名稱到 title/og 讓預覽一目了然，再交給前端。分身與群組共用 /s/。"""
    from fastapi.responses import HTMLResponse, RedirectResponse
    import html as _html
    token = re.sub(r"[^\w-]", "", token)

    def _page_for(title: str) -> str:
        page = (Path(__file__).parent / "index.html").read_text(encoding="utf-8")
        page = re.sub(r"<title>.*?</title>", f"<title>{title}</title>", page, count=1)
        # 拆掉靜態 head 的 og 標籤——爬蟲只取第一組，留著會蓋掉分享專屬的標題/圖
        return re.sub(r'<meta property="og:(?:title|description|image)" content="[^"]*"\s*/?>\s*', "", page)

    room = _find_shared_room(token)
    if room:
        title = f"圍觀「{_html.escape(room['title'])}」的分身群聊 · CopyMe 復刻"
        page = _page_for(title)
        inject = (
            f'<meta property="og:title" content="{title}">\n'
            f'<meta property="og:description" content="幾個 AI 分身在群組裡接力聊天——點開圍觀或插話。">\n'
            f'<base href="/">\n<script>window.__SHARE_ROOM__="{token}"</script>\n</head>'
        )
        return HTMLResponse(page.replace("</head>", inject, 1),
                            headers={"Cache-Control": "no-cache"})
    meta = _find_shared(token)
    if not meta:
        return RedirectResponse("/")
    name = _html.escape(meta["name"])
    title = f"跟「{name}」的分身聊聊 · CopyMe 復刻"
    page = _page_for(title)
    og_img = (f"https://copyme.fly.dev/{meta['avatar']}" if meta.get("avatar")
              else "https://copyme.fly.dev/art/alembic.webp")
    inject = (
        f'<meta property="og:title" content="{title}">\n'
        f'<meta property="og:description" content="{name} 的 AI 分身——從真實對話蒸餾而成，點開直接聊。">\n'
        f'<meta property="og:image" content="{og_img}">\n'
        f'<meta name="twitter:card" content="summary">\n'
        f'<base href="/">\n<script>window.__SHARE_TOKEN__="{token}"</script>\n</head>'
    )
    page = page.replace("</head>", inject, 1)
    return HTMLResponse(page, headers={"Cache-Control": "no-cache"})


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
    return _find_shared_room(token) is not None  # 群組分享連結的訪客也能上傳擴充語料


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
        # 留樣本供除錯（僅前 200KB，最多保留 20 份，其餘先進先出）
        try:
            fdir = DATA / "failed_uploads"
            fdir.mkdir(exist_ok=True)
            for old in sorted(fdir.glob("*.txt"))[:-19]:
                old.unlink()
            stamp = datetime.now(TZ).strftime("%Y%m%d-%H%M%S")
            (fdir / f"{stamp}-{re.sub(r'[^\w.-]', '_', file.filename or 'noname')[:60]}.txt"
             ).write_text(raw[:200_000], encoding="utf-8")
        except OSError:
            pass
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
    check_distill_budget(user)
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


def _distill_events(person: str, room: str, corpus: str, stats: dict, on_done,
                    bill_user=None, on_cost=None):
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
    usd = track_usage(final.usage, user=bill_user, model=use_model)
    if on_cost:
        on_cost(usd)
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
    # 群組分享連結：目標分身必須是該群組成員——語料只會補進正確的目標
    bill_room = None
    room_tok = re.sub(r"[^\w-]", "", str(payload.get("room_share") or ""))
    if not share_ok and room_tok:
        rm = _find_shared_room(room_tok)
        if rm and any(m["pid"] == pid for m in rm["members"]):
            if _fuel_left(rm) <= 0:
                raise HTTPException(402, "這條連結的燃料用完了——請群組建立者補充")
            share_ok, bill_room = True, rm
    user = ext_user
    if not share_ok and not (user and meta.get("owner_id") == user.get("id")):
        raise HTTPException(403, "只有擁有者或持公開連結者能擴充語料")
    if not share_ok:  # 擁有者自費重蒸——連結訪客走墨水/燃料，不看錢包
        check_distill_budget(user)

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

    def on_cost(usd: float) -> None:
        if bill_room is not None:  # 訪客經群組連結擴充：成本記到連結燃料
            bill_room["fuel_used_twd"] = round(
                bill_room.get("fuel_used_twd", 0) + usd * MARGIN * TWD_PER_USD, 2)
            _room_save(bill_room)

    return _detached_sse(_distill_events(name, meta.get("room", ""), corpus, stats, on_done,
                                         bill_user=ext_user, on_cost=on_cost))


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
        if user and meta.get("demo") and meta.get("owner_id") != user.get("id"):
            continue   # 示範分身是給訪客試玩的；登入者的書架只放自己的
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


@app.post("/api/personas/{pid}/rename")
def rename_persona(pid: str, payload: dict, authorization: str | None = Header(None)):
    """分身改名：僅擁有者。顯示層改名——人格檔內文不動，群組成員名單同步更新。"""
    user = require_user(authorization)
    pdir = PERSONAS / re.sub(r"[^a-f0-9]", "", pid)
    if not (pdir / "meta.json").exists():
        raise HTTPException(404, "找不到這個分身")
    meta = json.loads((pdir / "meta.json").read_text(encoding="utf-8"))
    if meta.get("owner_id") != user.get("id"):
        raise HTTPException(403, "只有擁有者能改名")
    name = str(payload.get("name") or "").strip()[:24]
    if not name:
        raise HTTPException(422, "名稱不能是空的")
    meta["name"] = name
    (pdir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    for f in ROOMS.glob("*.json"):   # 群組成員名單存的是快照，跟著改
        try:
            room = json.loads(f.read_text(encoding="utf-8"))
        except ValueError:
            continue
        hit = False
        for m in room.get("members", []):
            if m.get("pid") == meta["id"]:
                m["name"] = name
                hit = True
        if hit:
            f.write_text(json.dumps(room, ensure_ascii=False), encoding="utf-8")
    return {"name": name}


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


def _own_persona(pid: str, user) -> Path:
    pdir = PERSONAS / re.sub(r"[^a-f0-9]", "", pid)
    if not (pdir / "meta.json").exists():
        raise HTTPException(404, "找不到這個分身")
    meta = json.loads((pdir / "meta.json").read_text(encoding="utf-8"))
    if meta.get("owner_id") != user.get("id"):
        raise HTTPException(403, "只有擁有者能看這個分身的討論串")
    return pdir


@app.get("/api/personas/{pid}/threads")
def persona_threads(pid: str, authorization: str | None = Header(None)):
    """擁有者視角的討論串清單——訪客在公開連結上留下的對話，本人也要看得到。"""
    user = require_user(authorization)
    pdir = _own_persona(pid, user)
    meta = json.loads((pdir / "meta.json").read_text(encoding="utf-8"))
    return {"share": bool(meta.get("share")), "threads": _thread_list(pdir)}


@app.get("/api/personas/{pid}/threads/{tid}")
def persona_thread(pid: str, tid: str, authorization: str | None = Header(None)):
    pdir = _own_persona(pid, require_user(authorization))
    f = _threads_dir(pdir) / f"{re.sub(r'[^a-f0-9]', '', tid)}.json"
    if not f.exists():
        raise HTTPException(404, "找不到這串討論")
    return {"msgs": json.loads(f.read_text(encoding="utf-8")).get("msgs", [])}


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
                        "pool": round(meta.get("ink_twd", 0.0), 2),
                        "avatar": meta.get("avatar"),
                        "threads": _thread_list(mp.parent)}
    raise HTTPException(404, "連結已失效或被擁有者停用")


# ---------------------------------------------------------------- 群組：多分身有限接力
# 防自聊的機關是排程，不是 prompt：使用者發一句話 → 後端最多跑 relay 個 agent 回合就
# 硬停，且沒有新使用者發言時，累計自動回合到 AUTO_MAX 就拒絕再接力。前端擋不住也跑不掉。

ROOMS = DATA / "rooms"
ROOMS.mkdir(parents=True, exist_ok=True)

RELAY_DEFAULT = int(os.environ.get("PF_RELAY_DEFAULT", "2"))   # 一次接力預設回合數
RELAY_MAX = int(os.environ.get("PF_RELAY_MAX", "6"))           # 單次上限
AUTO_MAX = int(os.environ.get("PF_ROOM_AUTO_MAX", "12"))       # 無人類發言時的累計上限（預設）
AUTO_LIMIT = int(os.environ.get("PF_ROOM_AUTO_LIMIT", "16"))   # 使用者能調到的最大值
ROOM_CTX = 30                                                  # 帶進模型的最近訊息數
ROOM_MSG_KEEP = 400
USER_LABEL = "使用者"
PASS_MARK = "（沒什麼想補充）"

GROUP_RULES = """
--- 群組對話規則 ---
- 這是群組聊天：成員有你（{me}）、{others}，還有真人使用者（標記為「{user_label}」）
- 每則訊息前的「某某：」只是說話者標記；你回覆時直接說內容，不要自己加名字前綴
- 只講你自己的話。絕對不要替 {others} 或使用者發言、不要幫他們接話、不要旁白
- 一次只講 1-3 句，這是聊天不是演講
- 不要每輪都反問把話丟回去；沒有新東西講就簡短附和或收尾
- 這一輪你若真的沒什麼想說，就只回「{pass_mark}」五個字，不要硬掰"""


FUEL_DEFAULT = float(os.environ.get("PF_ROOM_FUEL_TWD", "10"))    # 每室預設燃料（NT$，可動態調）
FUEL_LIMIT = float(os.environ.get("PF_ROOM_FUEL_LIMIT", "1000"))  # 使用者能調到的最大值


def _fuel_left(room: dict) -> float:
    return room.get("fuel_twd", FUEL_DEFAULT) - room.get("fuel_used_twd", 0.0)


def _fclamp(v) -> float:
    try:
        return max(1.0, min(FUEL_LIMIT, float(v)))
    except (TypeError, ValueError):
        return FUEL_DEFAULT


def _rpath(rid: str) -> Path:
    return ROOMS / f"{re.sub(r'[^a-f0-9]', '', rid)}.json"


def _room_load(rid: str, user) -> dict:
    p = _rpath(rid)
    if not p.exists():
        raise HTTPException(404, "找不到這個群組")
    room = json.loads(p.read_text(encoding="utf-8"))
    if room.get("owner_id") != user.get("id"):
        raise HTTPException(403, "只有建立者能進這個群組")
    return room


def _room_save(room: dict) -> None:
    room["msgs"] = room["msgs"][-ROOM_MSG_KEEP:]
    _rpath(room["id"]).write_text(json.dumps(room, ensure_ascii=False), encoding="utf-8")


def _clamp(v, lo, hi, fallback):
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return fallback


def _auto_max(room: dict) -> int:
    return _clamp(room.get("auto_max", AUTO_MAX), 1, AUTO_LIMIT, AUTO_MAX)


def _room_brief(room: dict) -> dict:
    return {"id": room["id"], "title": room["title"], "members": room["members"],
            "count": len(room["msgs"]), "relay": room.get("relay", RELAY_DEFAULT),
            "auto_since_user": room.get("auto_since_user", 0),
            "auto_max": _auto_max(room), "auto_limit": AUTO_LIMIT,
            "relay_max": RELAY_MAX, "created": room.get("created", ""),
            "fuel_twd": room.get("fuel_twd", FUEL_DEFAULT),
            "fuel_used_twd": round(room.get("fuel_used_twd", 0.0), 2),
            "fuel_limit": FUEL_LIMIT, "avatar": room.get("avatar")}


def _speaker_msgs(msgs: list[dict], me_pid: str) -> list[dict]:
    """把群組逐字稿攤成該分身視角的 user/assistant 交錯串（同 role 相鄰就合併）。"""
    out: list[dict] = []
    for m in msgs[-ROOM_CTX:]:
        if m["role"] == "assistant" and m.get("pid") == me_pid:
            role, text = "assistant", m["content"]
        else:
            who = m.get("name") or USER_LABEL if m["role"] == "assistant" else USER_LABEL
            role, text = "user", f"{who}：{m['content']}"
        if out and out[-1]["role"] == role:
            out[-1]["content"] += "\n" + text
        else:
            out.append({"role": role, "content": text})
    if not out or out[0]["role"] != "user":
        out.insert(0, {"role": "user", "content": "（群組對話開始）"})
    if out[-1]["role"] != "user":
        out.append({"role": "user", "content": "（換你說一句）"})
    return out


def _mentioned(text: str, members: list[dict]):
    """使用者訊息點名了誰 → 那個人先講。全名、@任一名字片段、或任一 ≥2 字的名字片段出現即算。"""
    low = text.lower()
    for m in members:
        if m["name"] in text:
            return m
        for tok in m["name"].replace("-", " ").split():
            if len(tok) >= 2 and (f"@{tok.lower()}" in low or tok.lower() in low):
                return m
    return None


def _order(room: dict, first: dict | None, n: int) -> list[dict]:
    """輪流發言序：點名者優先，其餘按「最久沒發言」排——接力數小於成員數時也不會有人被輪空。"""
    ring = room["members"]
    if n <= 0 or not ring:
        return []
    last_at: dict[str, int] = {}
    for i, m in enumerate(room["msgs"]):
        if m["role"] == "assistant" and m.get("pid"):
            last_at[m["pid"]] = i
    rest = [m for m in ring if not first or m["pid"] != first["pid"]]
    rest.sort(key=lambda m: last_at.get(m["pid"], -1))  # 沒講過話的最優先
    seq = ([first] if first else []) + rest
    return [seq[i % len(seq)] for i in range(n)]


def _room_turn(room: dict, member: dict, primary: str, bill_user):
    """跑一個分身的回合：yield SSE 事件，最後 yield ("__done__", 文字)。"""
    pdir = PERSONAS / member["pid"]
    try:
        persona_text = (pdir / "persona.md").read_text(encoding="utf-8")
    except OSError:
        # 成員分身已被刪除 → 跳過這一位，接力繼續，不讓整條 SSE 掛掉
        yield sse("turn", {"pid": member["pid"], "name": member["name"],
                           "content": "", "passed": True})
        yield ("__done__", "__SKIP__", 0.0)
        return
    others = "、".join(m["name"] for m in room["members"] if m["pid"] != member["pid"])
    system = [
        {"type": "text", "text": persona_text, "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": CHAT_RULES.replace("{name}", member["name"])
                                 + GROUP_RULES.format(me=member["name"], others=others,
                                                      user_label=USER_LABEL,
                                                      pass_mark=PASS_MARK)},
    ]
    history = _speaker_msgs(room["msgs"], member["pid"])
    for use_model in (primary, FALLBACK_MODEL):
        chunks: list[str] = []
        try:
            with claude.messages.stream(
                model=use_model,
                max_tokens=500,
                output_config={"effort": "low"},
                system=system,
                messages=history,
            ) as stream:
                for text in stream.text_stream:
                    chunks.append(text)
                    yield sse("delta", {"text": text})
                final = stream.get_final_message()
            usd = track_usage(final.usage, user=bill_user, model=use_model)
            said = "".join(chunks).strip()
            # 模型偶爾仍會自己加名字前綴，統一剝掉
            said = re.sub(rf"^{re.escape(member['name'])}\s*[:：]\s*", "", said)
            yield ("__done__", "" if final.stop_reason == "refusal" else said,
                   usd * cur_margin() * cur_rate())
            return
        except anthropic.AnthropicError as e:
            txt = str(getattr(e, "message", "") or e).lower()
            transient = (getattr(e, "status_code", 0) in (429, 529)
                         or "overloaded" in txt or "rate limit" in txt)
            if transient and use_model != FALLBACK_MODEL and not chunks:
                continue
            yield sse("error", {"message": "模型目前壅塞，稍等幾秒再送一次" if transient
                                else f"Claude API 錯誤：{getattr(e, 'message', e)}"})
            yield ("__done__", None, 0.0)
            return


@app.get("/api/rooms")
def list_rooms(authorization: str | None = Header(None)):
    user = require_user(authorization)
    out = []
    for f in sorted(ROOMS.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            room = json.loads(f.read_text(encoding="utf-8"))
        except ValueError:
            continue
        if room.get("owner_id") == user.get("id"):
            out.append(_room_brief(room))
    return {"rooms": out, "relay_default": RELAY_DEFAULT, "relay_max": RELAY_MAX}


@app.post("/api/rooms")
def create_room(payload: dict, authorization: str | None = Header(None)):
    user = require_user(authorization)
    pids = [re.sub(r"[^a-f0-9]", "", str(p)) for p in (payload.get("members") or [])]
    pids = list(dict.fromkeys([p for p in pids if p]))
    if not (2 <= len(pids) <= 4):
        raise HTTPException(422, "一個群組要 2–4 個分身")
    members = []
    for pid in pids:
        mp = PERSONAS / pid / "meta.json"
        if not mp.exists():
            raise HTTPException(404, "找不到其中一個分身")
        meta = json.loads(mp.read_text(encoding="utf-8"))
        if not _visible(meta, user):
            raise HTTPException(403, f"「{meta['name']}」不是你的分身，不能拉進群組")
        if not (PERSONAS / pid / "persona.md").read_text(encoding="utf-8").strip():
            raise HTTPException(409, f"「{meta['name']}」的人格檔是空的，請重新蒸餾")
        members.append({"pid": pid, "name": meta["name"]})
    rid = secrets.token_hex(6)
    room = {"id": rid,
            "title": (str(payload.get("title") or "").strip()
                      or "、".join(m["name"] for m in members))[:40],
            "members": members, "owner_id": user["id"],
            "relay": _clamp(payload.get("relay", RELAY_DEFAULT), 1, RELAY_MAX, RELAY_DEFAULT),
            "auto_max": _clamp(payload.get("auto_max", AUTO_MAX), 1, AUTO_LIMIT, AUTO_MAX),
            "fuel_twd": _fclamp(payload.get("fuel_twd", FUEL_DEFAULT)),
            "fuel_used_twd": 0.0,
            "auto_since_user": 0, "msgs": [],
            "created": datetime.now(TZ).isoformat(timespec="seconds")}
    _room_save(room)
    return _room_brief(room)


@app.get("/api/rooms/{rid}")
def get_room(rid: str, authorization: str | None = Header(None)):
    room = _room_load(rid, require_user(authorization))
    return {**_room_brief(room), "msgs": room["msgs"][-120:]}


@app.post("/api/rooms/{rid}/settings")
def room_settings(rid: str, payload: dict, authorization: str | None = Header(None)):
    """使用者自訂接力上限：relay＝每次接幾回，auto_max＝沒你插話時最多連續接幾回。
    訪客（持群組分享連結）只能調 relay / auto_max；燃料額度與標題仍限建立者。"""
    share_tok = re.sub(r"[^\w-]", "", str(payload.get("share") or ""))
    visitor_room = _find_shared_room(share_tok) if share_tok else None
    if visitor_room and visitor_room["id"] == re.sub(r"[^a-f0-9]", "", rid):
        room = visitor_room
        payload = {k: v for k, v in payload.items() if k in ("relay", "auto_max")}
    else:
        user = require_user(authorization)
        room = _room_load(rid, user)
    if "relay" in payload:
        room["relay"] = _clamp(payload["relay"], 1, RELAY_MAX, room.get("relay", RELAY_DEFAULT))
    if "auto_max" in payload:
        room["auto_max"] = _clamp(payload["auto_max"], 1, AUTO_LIMIT, _auto_max(room))
    if "fuel_twd" in payload:      # 燃料額度隨時可加可減——這就是「動態調控」的旋鈕
        room["fuel_twd"] = _fclamp(payload["fuel_twd"])
    if "title" in payload:
        room["title"] = (str(payload["title"]).strip() or room["title"])[:40]
    _room_save(room)
    return _room_brief(room)


@app.post("/api/rooms/{rid}/members")
def room_members(rid: str, payload: dict, authorization: str | None = Header(None)):
    """動態調整群組成員：傳完整名單（2–4 位）取代現有名單。留下的成員保留原名快照；
    退出者的歷史發言不動（訊息上已存名字）。僅建立者可調。"""
    user = require_user(authorization)
    room = _room_load(rid, user)
    pids = [re.sub(r"[^a-f0-9]", "", str(p)) for p in (payload.get("members") or [])]
    pids = list(dict.fromkeys([p for p in pids if p]))
    if not (2 <= len(pids) <= 4):
        raise HTTPException(422, "一個群組要 2–4 個分身")
    old = {m["pid"]: m for m in room.get("members", [])}
    members = []
    for pid in pids:
        if pid in old:
            members.append(old[pid])
            continue
        mp = PERSONAS / pid / "meta.json"
        if not mp.exists():
            raise HTTPException(404, "找不到其中一個分身")
        meta = json.loads(mp.read_text(encoding="utf-8"))
        if not _visible(meta, user):
            raise HTTPException(403, f"「{meta['name']}」不是你的分身，不能拉進群組")
        if not (PERSONAS / pid / "persona.md").read_text(encoding="utf-8").strip():
            raise HTTPException(409, f"「{meta['name']}」的人格檔是空的，請重新蒸餾")
        members.append({"pid": pid, "name": meta["name"]})
    room["members"] = members
    _room_save(room)
    return _room_brief(room)


@app.post("/api/rooms/{rid}/avatar")
async def set_room_avatar(rid: str, file: UploadFile = File(...),
                          authorization: str | None = Header(None)):
    """群組頭貼（選填）：僅建立者。鏡射分身頭貼的做法。"""
    room = _room_load(rid, require_user(authorization))
    if not (file.content_type or "").startswith("image/"):
        raise HTTPException(422, "請上傳圖片檔")
    raw = await file.read()
    if len(raw) > 2_000_000:
        raise HTTPException(413, "圖片太大（上限 2MB）")
    (ROOMS / f"{room['id']}.avatar").write_bytes(raw)
    room["avatar"] = f"api/rooms/{room['id']}/avatar"
    room["avatar_ct"] = file.content_type
    _room_save(room)
    return {"avatar": room["avatar"]}


@app.get("/api/rooms/{rid}/avatar")
def get_room_avatar(rid: str):
    rid = re.sub(r"[^a-f0-9]", "", rid)
    f = ROOMS / f"{rid}.avatar"
    if not f.exists():
        raise HTTPException(404, "no avatar")
    ct = "image/jpeg"
    try:
        ct = json.loads(_rpath(rid).read_text(encoding="utf-8")).get("avatar_ct") or ct
    except (OSError, ValueError):
        pass
    return FileResponse(f, media_type=ct)


@app.post("/api/rooms/{rid}/share")
def share_room(rid: str, payload: dict, authorization: str | None = Header(None)):
    """群組公開連結開關：僅建立者。訪客的對話燒這一室的燃料額度，額度即天花板。"""
    room = _room_load(rid, require_user(authorization))
    if payload.get("enable"):
        room["share"] = room.get("share") or secrets.token_urlsafe(9)
    else:
        room.pop("share", None)
    _room_save(room)
    return {"share": room.get("share")}


@app.get("/api/shared-room/{token}")
def shared_room_info(token: str):
    """憑分享 token 取得群組資訊與逐字稿（免登入）。"""
    room = _find_shared_room(re.sub(r"[^\w-]", "", token))
    if not room:
        raise HTTPException(404, "連結已失效或被建立者停用")
    return {**{k: v for k, v in _room_brief(room).items()},
            "msgs": room["msgs"][-120:]}


@app.post("/api/rooms/{rid}/delete")
def delete_room(rid: str, payload: dict, authorization: str | None = Header(None)):
    _room_load(rid, require_user(authorization))
    _rpath(rid).unlink(missing_ok=True)
    (ROOMS / f"{re.sub(r'[^a-f0-9]', '', rid)}.avatar").unlink(missing_ok=True)
    return {"deleted": True}


@app.post("/api/rooms/{rid}/chat")
def room_chat(rid: str, payload: dict, request: Request,
              authorization: str | None = Header(None)):
    """一次呼叫 = 一段有限接力。content 有值＝人類發話（重置自動回合計數）；
    content 空＝「再跑一輪」，只在未超過 AUTO_MAX 時允許。"""
    check_code(payload.get("access_code"))
    share_tok = re.sub(r"[^\w-]", "", str(payload.get("share") or ""))
    if share_tok:
        # 訪客憑公開連結參與：用量計到建立者頭上，燃料額度就是訪客的天花板
        room = _find_shared_room(share_tok)
        if not room or room["id"] != re.sub(r"[^a-f0-9]", "", rid):
            raise HTTPException(404, "連結已失效或被建立者停用")
        user = {"id": room.get("owner_id", "")}
        guest = True
    else:
        user = require_user(authorization)
        room = _room_load(rid, user)
        guest = False
    check_budget(user)
    content = str(payload.get("content") or "").strip()
    relay = room.get("relay", RELAY_DEFAULT) if guest else \
        _clamp(payload.get("relay", room.get("relay", RELAY_DEFAULT)),
               1, RELAY_MAX, RELAY_DEFAULT)
    if not guest and "auto_max" in payload:   # 界線只有建立者能調
        room["auto_max"] = _clamp(payload["auto_max"], 1, AUTO_LIMIT, _auto_max(room))
    auto_max = _auto_max(room)

    if not guest and "fuel_twd" in payload:   # 燃料額度也只有建立者能調
        room["fuel_twd"] = _fclamp(payload["fuel_twd"])
    if content:
        room["msgs"].append({"role": "user", "name": "訪客" if guest else "", "pid": "",
                             "content": content})
        room["auto_since_user"] = 0
    elif not room["msgs"]:
        raise HTTPException(422, "先說一句話開場")
    if _fuel_left(room) <= 0:
        _room_save(room)
        raise HTTPException(402, f"這個群組的燃料額度（NT${room.get('fuel_twd', FUEL_DEFAULT):.0f}）"
                                 "燒完了——調高額度就能繼續")
    left = auto_max - room.get("auto_since_user", 0)
    if left <= 0:
        raise HTTPException(429, f"分身已經連續接力 {auto_max} 回合了——說句話再繼續吧")
    turns = _order(room, _mentioned(content, room["members"]) if content else None,
                   min(relay, left))
    room["relay"] = relay
    _room_save(room)
    primary = {"opus": MODEL, "sonnet": FALLBACK_MODEL}.get(
        str(payload.get("model") or ""), FALLBACK_MODEL)  # 未指定＝Sonnet；Opus 要人為切換

    def gen():
        stopped = "cap"
        done = spoke = 0
        for i, member in enumerate(turns):
            yield sse("speaker", {"pid": member["pid"], "name": member["name"],
                                  "i": i + 1, "total": len(turns)})
            said, cost_twd = None, 0.0
            for ev in _room_turn(room, member, primary, user):
                if isinstance(ev, tuple):
                    said, cost_twd = ev[1], ev[2]
                else:
                    yield ev
            if said is None:            # API 錯誤，事件已送出
                stopped = "error"
                break
            room["fuel_used_twd"] = room.get("fuel_used_twd", 0.0) + cost_twd
            if said == "__SKIP__":      # 成員已被刪除，換下一位
                continue
            done += 1
            room["auto_since_user"] = room.get("auto_since_user", 0) + 1
            if not said or said.startswith(PASS_MARK[:4]):
                # 這位真的沒話講 → 跳過換下一位；別讓一個有禮貌的成員擋死全隊
                yield sse("turn", {"pid": member["pid"], "name": member["name"],
                                   "content": "", "passed": True})
                _room_save(room)
                continue
            spoke += 1
            room["msgs"].append({"role": "assistant", "pid": member["pid"],
                                 "name": member["name"], "content": said})
            _room_save(room)
            yield sse("turn", {"pid": member["pid"], "name": member["name"],
                               "content": said, "passed": False})
            if _fuel_left(room) <= 0:   # 燃料在接力中途燒完 → 立即停
                stopped = "fuel"
                break
        if stopped == "cap" and spoke == 0 and done > 0:
            stopped = "pass"            # 全員都沒話講——別再自動續跑
        _room_save(room)
        yield sse("done", {"turns": done, "stopped": stopped,
                           "auto_since_user": room.get("auto_since_user", 0),
                           "auto_max": auto_max, "relay": relay,
                           "fuel_twd": room.get("fuel_twd", FUEL_DEFAULT),
                           "fuel_used_twd": round(room.get("fuel_used_twd", 0.0), 2)})

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache"})


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
    # 分享連結還有墨水 → 這筆對話燒墨水，不看錢包也不看體驗池
    ink_ok = share_ok and meta.get("ink_twd", 0.0) > 0
    if not ink_ok:
        check_budget(bill_user)
        if bill_user is None and not share_ok:
            check_guest_cap(request)
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
        str(payload.get("model") or ""), FALLBACK_MODEL)  # 未指定＝Sonnet；Opus 要人為切換

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
            # 公開連結的對話優先燒「連結墨水」；墨水乾了才落到訪客原本的計費路徑
            ink_billed = False
            if share_ok:
                mpath = pdir / "meta.json"
                m2 = json.loads(mpath.read_text(encoding="utf-8"))
                if m2.get("ink_twd", 0.0) > 0:
                    ink_usd = _usd(final.usage, use_model)
                    ink_twd = ink_usd * cur_margin() * cur_rate()
                    m2["ink_twd"] = round(m2["ink_twd"] - ink_twd, 2)
                    mpath.write_text(json.dumps(m2, ensure_ascii=False), encoding="utf-8")
                    _log_usage(final.usage, use_model, ink_usd, ink_twd, "ink", None)
                    ink_billed = True
            if not ink_billed:
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
