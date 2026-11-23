#!/usr/bin/env python3
"""抓取台股（上市＋上櫃）個股清單、月營收、每日股價，輸出成網頁使用的 JSON。

資料來源（皆為官方公開資料）：
  - 證交所 OpenAPI：上市公司基本資料 t187ap03_L、上市公司每月營業收入 t187ap05_L
  - 櫃買中心 OpenAPI：上櫃公司基本資料 mopsfin_t187ap03_O、上櫃公司每月營業收入 mopsfin_t187ap05_O
  - 證交所 MI_INDEX（每日收盤行情）、櫃買中心 dailyQuotes（上櫃股票行情）

輸出：
  data/stocks.json          個股清單＋最新行情＋最新營收（含實際公布日）＋發行股數
  data/revenue_dates.json   每家公司各月份營收的「實際公布日」紀錄（每天執行時偵測到新資料即記錄當天日期）
  data/prices/{代號}.json    日K資料 [[yyyymmdd, 開, 高, 低, 收, 成交張數], ...]
  data/prices/_meta.json     已抓取的交易日清單

用法：
  python3 scripts/fetch_data.py               # 增量更新（第一次執行會自動回補約 14 個月股價）
  python3 scripts/fetch_data.py --backfill-days 600
  python3 scripts/fetch_data.py --skip-prices # 只更新清單與營收
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PRICES = DATA / "prices"
CACHE = ROOT / "cache"
TZ = dt.timezone(dt.timedelta(hours=8))
UA = "Mozilla/5.0 (compatible; tw-stock-dashboard/1.0)"
MAX_ROWS = 420  # 每檔最多保留的交易日數


def log(*a):
    print(*a, file=sys.stderr, flush=True)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):  # 證交所限流時會 307 轉址到封鎖頁，不跟隨
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def get_json(url: str, retries: int = 6):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with _opener.open(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8-sig"))
        except Exception as e:  # noqa: BLE001
            last = e
            limited = getattr(e, "code", None) in (302, 307, 403, 429)
            wait = (90 if limited else 5) * (i + 1)  # 被限流時等久一點
            log(f"  ! {url} 失敗 ({e})，{wait}s 後重試")
            time.sleep(wait)
    raise RuntimeError(f"無法取得 {url}: {last}")


def num(s):
    if s is None:
        return None
    s = str(s).replace(",", "").strip()
    if s in ("", "--", "---", "----", "X", "除權息", "除息", "除權"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def roc_ym(s: str) -> str:
    """'11510' -> '2026-10'"""
    s = s.strip()
    return f"{int(s[:-2]) + 1911}-{s[-2:]}"


def now_tw() -> dt.datetime:
    return dt.datetime.now(TZ)


# ---------------------------------------------------------------- 清單與營收
def fetch_companies():
    listed = get_json("https://openapi.twse.com.tw/v1/opendata/t187ap03_L")
    otc = get_json("https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O")
    rev_l = get_json("https://openapi.twse.com.tw/v1/opendata/t187ap05_L")
    rev_o = get_json("https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O")

    companies = {}
    for r in listed:
        c = r["公司代號"].strip()
        companies[c] = {"c": c, "n": r["公司簡稱"].strip(), "m": "上市", "_ic": r["產業別"].strip(),
                        "sh": num(r.get("已發行普通股數或TDR原股發行股數"))}
    for r in otc:
        c = r["SecuritiesCompanyCode"].strip()
        companies[c] = {"c": c, "n": r["CompanyAbbreviation"].strip(), "m": "上櫃",
                        "_ic": r["SecuritiesIndustryCode"].strip(), "sh": num(r.get("IssueShares"))}

    revenue = {}
    code_to_ind = {}
    for r in rev_l + rev_o:
        c = r["公司代號"].strip()
        revenue[c] = {
            "ym": roc_ym(r["資料年月"]),
            "rev": num(r["營業收入-當月營收"]),
            "mom": num(r["營業收入-上月比較增減(%)"]),
            "yoy": num(r["營業收入-去年同月增減(%)"]),
            "cum": num(r["累計營業收入-當月累計營收"]),
            "cumYoy": num(r["累計營業收入-前期比較增減(%)"]),
        }
        if c in companies:
            ind = r["產業別"].strip()
            companies[c]["ind"] = ind
            code_to_ind.setdefault((companies[c]["m"], companies[c]["_ic"]), ind)
    for co in companies.values():
        if "ind" not in co:
            co["ind"] = code_to_ind.get((co["m"], co["_ic"]), "其他")
        del co["_ic"]
    log(f"公司數：上市 {len(listed)}、上櫃 {len(otc)}；營收筆數 {len(revenue)}")
    return companies, revenue


def deadline_for(ym: str) -> dt.date:
    """ym 月份營收的法定公布期限：次月 10 日（遇週末順延至週一）。"""
    y, m = map(int, ym.split("-"))
    y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    d = dt.date(y, m, 10)
    while d.weekday() >= 5:
        d += dt.timedelta(days=1)
    return d


def update_revenue_dates(revenue: dict) -> dict:
    path = DATA / "revenue_dates.json"
    first_run = not path.exists()
    rd = json.loads(path.read_text("utf-8")) if path.exists() else {}
    today = now_tw().date()
    new = 0
    for c, r in revenue.items():
        ym = r["ym"]
        hist = rd.setdefault(c, {})
        if ym in hist:
            continue
        # 只有在法定期限附近（次月 1 日～期限後 25 天）首次看到，才當作「實際公布日」
        dl = deadline_for(ym)
        in_window = dl.replace(day=1) <= today <= dl + dt.timedelta(days=25)
        hist[ym] = None if (first_run or not in_window) else today.isoformat()
        new += 1
    path.write_text(json.dumps(rd, ensure_ascii=False, separators=(",", ":"), sort_keys=True), "utf-8")
    log(f"營收公布日紀錄：新增 {new} 筆{'（首次執行，日期未知）' if first_run else ''}")
    return rd


# ---------------------------------------------------------------- 股價
def fetch_twse_day(d: dt.date):
    url = f"https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date={d:%Y%m%d}&type=ALLBUT0999"
    j = get_json(url)
    if j.get("stat") not in (None, "OK"):
        return None
    for t in j.get("tables", []):
        f = t.get("fields") or []
        if "證券代號" in f and "收盤價" in f:
            ix = {k: f.index(k) for k in ("證券代號", "開盤價", "最高價", "最低價", "收盤價", "成交股數")}
            out = {}
            for row in t["data"]:
                out[row[ix["證券代號"]].strip()] = (
                    num(row[ix["開盤價"]]), num(row[ix["最高價"]]), num(row[ix["最低價"]]),
                    num(row[ix["收盤價"]]), num(row[ix["成交股數"]]))
            return out or None
    return None


def fetch_tpex_day(d: dt.date):
    url = f"https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date={d:%Y/%m/%d}&response=json"
    j = get_json(url)
    tables = j.get("tables") or []
    if not tables or not tables[0].get("data"):
        return None
    t = tables[0]
    f = [x.strip() for x in t["fields"]]
    ix = {k: f.index(k) for k in ("代號", "開盤", "最高", "最低", "收盤", "成交股數")}
    out = {}
    for row in t["data"]:
        out[row[ix["代號"]].strip()] = (
            num(row[ix["開盤"]]), num(row[ix["最高"]]), num(row[ix["最低"]]),
            num(row[ix["收盤"]]), num(row[ix["成交股數"]]))
    return out or None


def load_prices(code):
    p = PRICES / f"{code}.json"
    return json.loads(p.read_text()) if p.exists() else []


def update_prices(companies: dict, backfill_days: int):
    meta_p = PRICES / "_meta.json"
    meta = json.loads(meta_p.read_text()) if meta_p.exists() else {"dates": [], "checked": []}
    have = set(meta["dates"])
    checked = set(meta.get("checked", []))  # 已確認為非交易日
    now = now_tw()
    end = now.date()
    if now.hour < 15:  # 收盤資料約 14:30 後才完整
        end -= dt.timedelta(days=1)
    start = end - dt.timedelta(days=backfill_days)
    if meta["dates"]:
        last = dt.datetime.strptime(meta["dates"][-1], "%Y%m%d").date()
        start = max(start, last - dt.timedelta(days=7))

    todo = []
    d = start
    while d <= end:
        k = f"{d:%Y%m%d}"
        if d.weekday() < 5 and k not in have and k not in checked:
            todo.append(d)
        d += dt.timedelta(days=1)
    log(f"需抓取股價日數：{len(todo)}")
    if not todo:
        return meta

    # 上市、上櫃分屬不同主機，各自用一條執行緒依序抓取（保留間隔避免被限流）。
    # 每天的結果先存到 cache/，中斷後重跑不必重抓。
    CACHE.mkdir(exist_ok=True)

    def run(name, fetch, pause):
        res = {}
        for n, d in enumerate(todo):
            cp = CACHE / f"{name}_{d:%Y%m%d}.json"
            if cp.exists():
                res[d] = json.loads(cp.read_text()) or None
                continue
            if name == "tpex" and res_tw_none(d):
                res[d] = None
                continue
            res[d] = fetch(d)
            if res[d] or d < now.date():
                cp.write_text(json.dumps(res[d] or {}, separators=(",", ":")))
            if (n + 1) % 20 == 0:
                log(f"  {name}: {n + 1}/{len(todo)}")
            time.sleep(pause)
        return res

    def res_tw_none(d):  # 上市確定沒資料（非交易日）時，上櫃就不用抓
        cp = CACHE / f"twse_{d:%Y%m%d}.json"
        return cp.exists() and cp.read_text() == "{}"

    with ThreadPoolExecutor(2) as ex:
        f_tw = ex.submit(run, "twse", fetch_twse_day, 4.0)
        f_tp = ex.submit(run, "tpex", fetch_tpex_day, 1.5)
        tw_all, tp_all = f_tw.result(), f_tp.result()

    bars: dict[str, dict[int, list]] = {}
    for i, d in enumerate(todo):
        k = f"{d:%Y%m%d}"
        tw, tp = tw_all[d], tp_all[d]
        if not tw:
            if d < now.date():
                checked.add(k)
            log(f"  {k} 非交易日")
            continue
        n = 0
        for src in (tw, tp or {}):
            for code, (o, h, l, c, v) in src.items():
                if code not in companies or c is None:
                    continue
                o, h, l = o or c, h or c, l or c
                bars.setdefault(code, {})[int(k)] = [int(k), o, h, l, c, round((v or 0) / 1000)]
                n += 1
        have.add(k)
        log(f"  [{i + 1}/{len(todo)}] {k} 上市 {len(tw)} / 上櫃 {len(tp or {})} -> {n} 檔")

    for code, newbars in bars.items():
        rows = {r[0]: r for r in load_prices(code)}
        rows.update(newbars)
        out = [rows[k] for k in sorted(rows)][-MAX_ROWS:]
        (PRICES / f"{code}.json").write_text(json.dumps(out, separators=(",", ":")))

    meta = {"dates": sorted(have)[-MAX_ROWS:], "checked": sorted(checked)[-400:]}
    meta_p.write_text(json.dumps(meta))
    return meta


# ---------------------------------------------------------------- 主程式
def build_stocks(companies, revenue, rev_dates):
    out = []
    for c in sorted(companies):
        co = dict(companies[c])
        rows = load_prices(c)
        if rows:
            last = rows[-1]
            co["p"] = last[4]
            co["v"] = last[5]
            if len(rows) > 1 and rows[-2][4]:
                prev = rows[-2][4]
                co["chg"] = round(last[4] - prev, 2)
                co["pct"] = round((last[4] - prev) / prev * 100, 2)
        r = revenue.get(c)
        if r:
            co["rev"] = r
            co["rev"]["date"] = rev_dates.get(c, {}).get(r["ym"])
        if not co.get("sh"):
            co.pop("sh", None)
        out.append(co)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill-days", type=int, default=430, help="首次回補的日曆天數")
    ap.add_argument("--skip-prices", action="store_true")
    args = ap.parse_args()

    DATA.mkdir(exist_ok=True)
    PRICES.mkdir(exist_ok=True)
    companies, revenue = fetch_companies()
    rev_dates = update_revenue_dates(revenue)
    meta = {"dates": []}
    if not args.skip_prices:
        meta = update_prices(companies, args.backfill_days)
    elif (PRICES / "_meta.json").exists():
        meta = json.loads((PRICES / "_meta.json").read_text())

    stocks = build_stocks(companies, revenue, rev_dates)
    payload = {
        "updated": now_tw().strftime("%Y-%m-%d %H:%M"),
        "lastTradeDate": meta["dates"][-1] if meta.get("dates") else None,
        "stocks": stocks,
    }
    (DATA / "stocks.json").write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), "utf-8")
    log(f"完成：{len(stocks)} 檔 -> data/stocks.json")


if __name__ == "__main__":
    main()
