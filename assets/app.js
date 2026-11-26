/* 台股營收行事曆 —— 前端邏輯（純靜態，讀取 data/*.json） */
(() => {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  const MA_DEFS = [
    { n: 5, color: "#f59e0b" },
    { n: 10, color: "#8b5cf6" },
    { n: 20, color: "#2563eb" },
    { n: 60, color: "#10b981" },
    { n: 120, color: "#ec4899" },
  ];
  const PAGE = 100;
  const DOW = "日一二三四五六";

  const state = {
    stocks: [],
    byCode: new Map(),
    revDates: {},
    events: [],          // 實際公布：{date, s, ym}
    eventsByDate: new Map(),
    sortKey: "c", sortAsc: true, page: 0,
    favs: new Set(store.get("favs", [])),
    calMonth: null, calSel: null,
    maOn: store.get("maOn", Object.fromEntries(MA_DEFS.map(m => [m.n, true]))),
    range: store.get("range", 130),
  };

  // ---------------------------------------------------------------- 工具
  const todayStr = () => {
    const d = new Date(Date.now() + 8 * 3600e3); // 台灣時間
    return d.toISOString().slice(0, 10);
  };
  const fmt = (v, d = 2) => v == null || isNaN(v) ? "—" : Number(v).toLocaleString("zh-TW", { minimumFractionDigits: d, maximumFractionDigits: d });
  const cls = v => v > 0 ? "up" : v < 0 ? "down" : "";
  const sign = v => v > 0 ? "+" : "";
  const ymLabel = ym => ym ? `${+ym.slice(0, 4) - 1911}/${ym.slice(5)}` : "—";
  const mdLabel = d => `${+d.slice(5, 7)}/${+d.slice(8, 10)}（${DOW[new Date(d + "T00:00:00").getDay()]}）`;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const mcap = s => s.p != null && s.sh ? s.p * s.sh / 1e8 : null; // 市值（億元）
  // 均線排列：1 多頭（MA20>MA60>MA120）、-1 空頭（MA20<MA60<MA120）、0 糾結；無資料為 undefined
  const AL_TEXT = { 1: "多頭排列", "-1": "空頭排列", 0: "均線糾結" };
  const alBadge = s => s.al == null ? '<span class="muted">—</span>'
    : `<span class="al al-${s.al === 1 ? "bull" : s.al === -1 ? "bear" : "flat"}">${AL_TEXT[s.al]}</span>`;
  const alMatch = (s, v) => v === "" || s.al === +v;

  // ---------------------------------------------------------------- 載入
  async function load() {
    const [st, rd] = await Promise.all([
      fetch("data/stocks.json", { cache: "no-cache" }).then(r => r.json()),
      fetch("data/revenue_dates.json", { cache: "no-cache" }).then(r => r.json()).catch(() => ({})),
    ]);
    state.stocks = st.stocks;
    state.revDates = rd;
    st.stocks.forEach(s => state.byCode.set(s.c, s));
    const ltd = st.lastTradeDate ? `${st.lastTradeDate.slice(0, 4)}-${st.lastTradeDate.slice(4, 6)}-${st.lastTradeDate.slice(6)}` : "—";
    $("#updated").textContent = `資料更新：${st.updated}｜行情日期：${ltd}｜共 ${st.stocks.length} 檔`;

    buildEvents();
    const inds = [...new Set(st.stocks.map(s => s.ind))].sort((a, b) => a.localeCompare(b, "zh-Hant"));
    $("#f-ind").insertAdjacentHTML("beforeend", inds.map(i => `<option>${esc(i)}</option>`).join(""));

    const alCount = { 1: 0, "-1": 0, 0: 0 };
    st.stocks.forEach(s => { if (s.al != null) alCount[s.al]++; });
    $$(".al-select option").forEach(o => { if (o.value !== "") o.textContent = `${AL_TEXT[o.value]}（${alCount[o.value]} 檔）`; });
    $("#rk-ind").insertAdjacentHTML("beforeend", inds.map(i => `<option>${esc(i)}</option>`).join(""));
    renderSoon();
    renderTable();
    renderRank();
    renderScreenConds();
    renderScreen();
    const t = todayStr();
    state.calMonth = t.slice(0, 7);
    state.calSel = t;
    renderCalendar();
    if (location.hash.length > 1) openStock(decodeURIComponent(location.hash.slice(1)));
  }

  function buildEvents() {
    const ev = [];
    for (const s of state.stocks) {
      const hist = state.revDates[s.c] || {};
      for (const [ym, d] of Object.entries(hist)) if (d) ev.push({ date: d, s, ym, type: "actual" });
    }
    state.events = ev;
    state.eventsByDate = new Map();
    for (const e of ev) {
      if (!state.eventsByDate.has(e.date)) state.eventsByDate.set(e.date, []);
      state.eventsByDate.get(e.date).push(e);
    }
  }

  // ---------------------------------------------------------------- 近期公布
  function renderSoon() {
    const t = todayStr();
    const recent = [...state.eventsByDate.keys()].filter(d => d <= t).sort().reverse().slice(0, 3);
    if (!recent.length) { $("#soon").innerHTML = ""; return; }
    const first = state.eventsByDate.get(recent[0]);
    let html = `<div><b>最近公布營收：</b>` + recent.map(d =>
      `<span class="muted" style="font-size:13px;margin-left:6px">${mdLabel(d)} ${state.eventsByDate.get(d).length} 家</span>`).join("") + `</div>`;
    html += `<div>${chips(first, 40)} <a href="#" id="soon-more" class="muted">查看行事曆 ›</a></div>`;
    $("#soon").innerHTML = html;
    $$("#soon .chip").forEach(c => c.onclick = () => openStock(c.dataset.c));
    $("#soon-more").onclick = e => { e.preventDefault(); state.calSel = recent[0]; state.calMonth = recent[0].slice(0, 7); switchTab("calendar"); renderCalendar(); };
  }
  function chips(list, max = 30) {
    const sorted = [...list].sort((a, b) => (state.favs.has(b.s.c) - state.favs.has(a.s.c)) || (b.s.v || 0) - (a.s.v || 0));
    const shown = sorted.slice(0, max).map(e => `<span class="chip" data-c="${e.s.c}">${state.favs.has(e.s.c) ? "★" : ""}${e.s.c} ${esc(e.s.n)}</span>`).join("");
    return shown + (list.length > max ? `<span class="muted"> …等 ${list.length} 家</span>` : "");
  }

  // ---------------------------------------------------------------- 股票列表
  function matches(s, q) {
    if (!q) return true;
    q = q.trim().toLowerCase();
    return s.c.startsWith(q) || s.n.toLowerCase().includes(q);
  }
  function sortVal(s, k) {
    switch (k) {
      case "revYm": return s.rev?.ym ?? "";
      case "rev": return s.rev?.rev ?? -Infinity;
      case "yoy": return s.rev?.yoy ?? -Infinity;
      case "revDate": return s.rev?.date ?? "";
      case "cap": return mcap(s) ?? -Infinity;
      case "al": return s.al ?? -Infinity;
      case "p": case "pct": case "v": return s[k] ?? -Infinity;
      default: return s[k] ?? "";
    }
  }
  function filtered() {
    const q = $("#search").value, m = $("#f-market").value, ind = $("#f-ind").value, fav = $("#f-fav").checked, al = $("#f-al").value;
    const list = state.stocks.filter(s => matches(s, q) && (!m || s.m === m) && (!ind || s.ind === ind) && (!fav || state.favs.has(s.c)) && alMatch(s, al));
    const k = state.sortKey, dir = state.sortAsc ? 1 : -1;
    list.sort((a, b) => {
      const x = sortVal(a, k), y = sortVal(b, k);
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir || a.c.localeCompare(b.c);
    });
    return list;
  }
  function renderTable() {
    const list = filtered();
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    state.page = Math.min(state.page, pages - 1);
    const rows = list.slice(state.page * PAGE, (state.page + 1) * PAGE).map(s => {
      const r = s.rev;
      return `<tr data-c="${s.c}">
        <td><button class="star" data-fav="${s.c}">${state.favs.has(s.c) ? "★" : "☆"}</button></td>
        <td>${s.c}</td><td>${esc(s.n)}</td><td>${s.m}</td><td>${esc(s.ind)}</td>
        <td class="r ${cls(s.chg)}">${fmt(s.p)}</td>
        <td class="r ${cls(s.pct)}">${s.pct == null ? "—" : sign(s.pct) + fmt(s.pct) + "%"}</td>
        <td class="r">${fmt(s.v, 0)}</td>
        <td class="r">${fmt(mcap(s), 0)}</td>
        <td>${alBadge(s)}</td>
        <td>${r ? ymLabel(r.ym) : "—"}</td>
        <td class="r">${r ? fmt(r.rev / 1e5, 2) : "—"}</td>
        <td class="r ${cls(r?.yoy)}">${r?.yoy == null ? "—" : sign(r.yoy) + fmt(r.yoy) + "%"}</td>
        <td>${r?.date ? mdLabel(r.date) : '<span class="muted">—</span>'}</td>
      </tr>`;
    }).join("");
    $("#table tbody").innerHTML = rows || `<tr><td colspan="14" class="muted" style="text-align:center;padding:30px">查無符合的股票</td></tr>`;
    $("#count").textContent = `共 ${list.length} 檔`;
    $("#pageinfo").textContent = `${state.page + 1} / ${pages}`;
    $("#prev").disabled = state.page === 0;
    $("#next").disabled = state.page >= pages - 1;
    $$("#table th").forEach(th => {
      th.classList.toggle("sorted", th.dataset.k === state.sortKey);
      th.classList.toggle("asc", th.dataset.k === state.sortKey && state.sortAsc);
    });
  }

  function toggleFav(c) {
    state.favs.has(c) ? state.favs.delete(c) : state.favs.add(c);
    store.set("favs", [...state.favs]);
    renderTable(); renderSoon(); renderCalendar();
    if (current?.s.c === c) $("#fav-btn").textContent = state.favs.has(c) ? "★" : "☆";
  }

  // ---------------------------------------------------------------- 行事曆
  function renderCalendar() {
    const [y, m] = state.calMonth.split("-").map(Number);
    $("#cal-title").textContent = `${y} 年 ${m} 月`;
    const first = new Date(y, m - 1, 1);
    const start = new Date(first); start.setDate(1 - first.getDay());
    const t = todayStr();
    const favOnly = $("#cal-fav").checked;
    let html = "";
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (i >= 35 && d.getMonth() !== m - 1) break;
      const list = (state.eventsByDate.get(ds) || []).filter(e => !favOnly || state.favs.has(e.s.c));
      const top = [...list].sort((a, b) => (state.favs.has(b.s.c) - state.favs.has(a.s.c)) || (b.s.v || 0) - (a.s.v || 0)).slice(0, 3);
      html += `<div class="cell ${d.getMonth() !== m - 1 ? "other" : ""} ${ds === t ? "today" : ""} ${ds === state.calSel ? "sel" : ""}" data-d="${ds}">
        <div class="dn">${d.getDate()}</div>
        ${list.length ? `<div class="cnt"><i class="dot actual"></i>${list.length} 家</div>` : ""}
        ${top.length ? `<div class="names">${top.map(e => esc(e.s.n)).join("、")}${list.length > 3 ? "…" : ""}</div>` : ""}
      </div>`;
    }
    $("#cal-grid").innerHTML = html;
    $$("#cal-grid .cell").forEach(el => el.onclick = () => { state.calSel = el.dataset.d; renderCalendar(); });
    renderDay();
  }
  function renderDay() {
    const ds = state.calSel;
    const favOnly = $("#cal-fav").checked;
    const list = (state.eventsByDate.get(ds) || []).filter(e => !favOnly || state.favs.has(e.s.c));
    let html = `<h3>${ds ? mdLabel(ds) : ""} 營收公布</h3>`;
    if (!list.length) html += `<p class="muted">這天沒有營收公布紀錄</p>`;
    {
      const l = [...list].sort((a, b) => (state.favs.has(b.s.c) - state.favs.has(a.s.c)) || a.s.c.localeCompare(b.s.c));
      if (l.length) html += `<div class="muted">已公布（${l.length}）</div><ul>` + l.map(e => {
        const r = e.s.rev && e.s.rev.ym === e.ym ? e.s.rev : null;
        return `<li data-c="${e.s.c}"><span>${state.favs.has(e.s.c) ? "★" : ""}${e.s.c} ${esc(e.s.n)}</span>
          <span class="muted">${ymLabel(e.ym)}${r?.yoy != null ? ` <span class="${cls(r.yoy)}">YoY ${sign(r.yoy)}${fmt(r.yoy, 1)}%</span>` : ""}</span></li>`;
      }).join("") + `</ul>`;
    }
    $("#cal-day").innerHTML = html;
    $$("#cal-day li").forEach(li => li.onclick = () => openStock(li.dataset.c));
  }
  function shiftMonth(n) {
    let [y, m] = state.calMonth.split("-").map(Number);
    m += n; if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; }
    state.calMonth = `${y}-${String(m).padStart(2, "0")}`;
    renderCalendar();
  }

  // ---------------------------------------------------------------- 產業排行榜
  const RANK_METRICS = {
    cap: { label: "市值", val: mcap, show: v => fmt(v, 0) + " 億" },
    rev: { label: "月營收", val: s => s.rev?.rev != null ? s.rev.rev / 1e5 : null, show: v => fmt(v, 2) + " 億" },
    yoy: { label: "月營收年增率", val: s => s.rev?.yoy, show: v => sign(v) + fmt(v, 1) + "%", color: true },
    cumYoy: { label: "累計營收年增率", val: s => s.rev?.cumYoy, show: v => sign(v) + fmt(v, 1) + "%", color: true },
    pct: { label: "漲跌幅", val: s => s.pct, show: v => sign(v) + fmt(v, 2) + "%", color: true },
    v: { label: "成交量", val: s => s.v, show: v => fmt(v, 0) + " 張" },
  };
  function renderRank() {
    const key = $("#rk-metric").value, M = RANK_METRICS[key];
    const mk = $("#rk-market").value, only = $("#rk-ind").value, asc = $("#rk-order").value === "asc";
    const groups = new Map();
    for (const s of state.stocks) {
      if (mk && s.m !== mk) continue;
      if (only && s.ind !== only) continue;
      if (!alMatch(s, $("#rk-al").value)) continue;
      if (!groups.has(s.ind)) groups.set(s.ind, { all: 0, cap: 0, list: [] });
      const g = groups.get(s.ind);
      g.all++; g.cap += mcap(s) || 0;
      const v = M.val(s);
      if (v != null && !isNaN(v)) g.list.push([s, v]);
    }
    const inds = [...groups.entries()].sort((a, b) => b[1].cap - a[1].cap);
    $("#rank-grid").innerHTML = inds.map(([ind, g]) => {
      const top = g.list.sort((a, b) => asc ? a[1] - b[1] : b[1] - a[1]).slice(0, 10);
      return `<div class="rank-card">
        <h3>${esc(ind)} <span class="muted">${g.all} 檔</span></h3>
        <ol>${top.map(([s, v], i) => `<li data-c="${s.c}">
          <span class="rk-no rk-${i + 1}">${i + 1}</span>
          <span class="rk-name">${state.favs.has(s.c) ? "★" : ""}${s.c} ${esc(s.n)}</span>
          <span class="rk-val ${M.color ? cls(v) : ""}">${M.show(v)}</span>
        </li>`).join("") || `<li class="muted">無資料</li>`}</ol>
      </div>`;
    }).join("") || `<p class="muted">沒有符合條件的產業</p>`;
    $("#rk-count").textContent = `共 ${inds.length} 個產業`;
  }

  // ---------------------------------------------------------------- 價位結構（常見接手區／突破觀察／近端擴展）
  // 台股升降單位
  const tickOf = p => p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5;
  const roundTick = p => { const t = tickOf(p); return +(Math.round(p / t) * t).toFixed(2); };
  const limitUpOf = prev => { const lim = prev * 1.1, t = tickOf(lim); return +(Math.floor(lim / t + 1e-9) * t).toFixed(2); };
  // 參數比照 2tonstock：近端 ±10%、中期 10～20%；合併容差 = clamp(0.6 × ATR%, 1%, 3%)，
  // 接手區用容差的一半合併、突破觀察用完整容差合併；近端擴展只取一道
  const LV = { minBars: 20, atrN: 20, nearPct: 10, midPct: 20, tolK: 0.6, tolMin: 1, tolMax: 3, zzMin: 0.04, zzAtrK: 2.5 };

  // 平均真實波幅（ATR）
  function atr(rows, n = LV.atrN) {
    const k = rows.length; if (k < 2) return 0;
    let sum = 0, cnt = 0;
    for (let i = Math.max(1, k - n); i < k; i++) {
      const [, , h, l] = rows[i], pc = rows[i - 1][4];
      sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); cnt++;
    }
    return sum / cnt;
  }

  // ZigZag：價格自前一個高（低）點反向超過門檻才算一次「有效轉折」
  function zigzag(rows, th) {
    const piv = [];
    let dir = 0, ext = null, extI = 0, hi = rows[0][2], hiI = 0, lo = rows[0][3], loI = 0;
    for (let i = 1; i < rows.length; i++) {
      const h = rows[i][2], l = rows[i][3];
      if (dir === 0) {
        if (h > hi) { hi = h; hiI = i; }
        if (l < lo) { lo = l; loI = i; }
        if (hi >= lo * (1 + th) && hiI > loI) { piv.push({ i: loI, p: lo, type: "L" }); dir = 1; ext = hi; extI = hiI; }
        else if (hi >= lo * (1 + th) && loI > hiI) { piv.push({ i: hiI, p: hi, type: "H" }); dir = -1; ext = lo; extI = loI; }
      } else if (dir === 1) {
        if (h > ext) { ext = h; extI = i; }
        else if (l <= ext * (1 - th)) { piv.push({ i: extI, p: ext, type: "H" }); dir = -1; ext = l; extI = i; }
      } else {
        if (l < ext) { ext = l; extI = i; }
        else if (h >= ext * (1 + th)) { piv.push({ i: extI, p: ext, type: "L" }); dir = 1; ext = h; extI = i; }
      }
    }
    return piv; // 只回傳已確認的轉折（最後一段尚未反轉的極值不算）
  }

  // 由近到遠合併轉折：以每個價格帶「最靠近現價的那一端」為錨點，距錨點在容差內才併入（不連鎖擴張）
  function clusterBands(pivots, tolPct, side) {
    const ps = [...pivots].sort((a, b) => side === "down" ? b.p - a.p : a.p - b.p);
    const bands = [];
    for (const v of ps) {
      const b = bands[bands.length - 1];
      const anchor = b && (side === "down" ? b.hi : b.lo);
      if (b && Math.abs(anchor - v.p) / anchor * 100 <= tolPct) {
        if (side === "down") b.lo = v.p; else b.hi = v.p;
        b.n++; b.last = Math.max(b.last, v.i);
      } else bands.push({ lo: v.p, hi: v.p, n: 1, last: v.i });
    }
    return bands;
  }

  // 依台股升降單位取整，且保證接手區在現價之下、壓力在現價之上
  function tickDir(p, side, close) {
    let v = roundTick(p);
    const t = tickOf(close);
    if (side === "down" && v >= close - 1e-9) v = +((Math.ceil(close / t - 1e-6) - 1) * t).toFixed(2);
    if (side === "up" && v <= close + 1e-9) v = +((Math.floor(close / t + 1e-6) + 1) * t).toFixed(2);
    return v;
  }

  function computeLevels(rows) {
    if (rows.length < LV.minBars) return { status: "資料不足", note: `收盤 K 線不足 ${LV.minBars} 根，不做結構選點。` };
    const close = rows[rows.length - 1][4];
    const a = atr(rows);
    const atrPct = a / close * 100;
    const th = Math.max(LV.zzMin, LV.zzAtrK * a / close);                         // 有效轉折門檻：至少 4% 或 2.5 倍 ATR
    const tol = Math.max(LV.tolMin, Math.min(LV.tolMax, LV.tolK * atrPct));         // 波動容差（%）：0.6 倍 ATR%，夾在 1%～3%
    const piv = zigzag(rows, th);
    const pct = p => (p - close) / close * 100;

    // 常見接手區：現價下方的轉折，以容差的一半合併；距離以價格帶上緣（最接近現價的一端）計算
    const below = clusterBands(piv.filter(v => v.p < close * 0.999), tol / 2, "down").map(b => {
      const hi = tickDir(b.hi, "down", close), lo = tickDir(b.lo, "down", close);
      return { ...b, hi, lo: Math.min(lo, hi), d: pct(hi) };
    });
    const supIn = below.filter(b => -b.d <= LV.midPct);
    const sup = supIn.slice(0, 2).map((b, k) => {
      const near = -b.d <= LV.nearPct;
      return { ...b, name: k ? "第二常見接手區" : "第一常見接手區", zone: near ? "近端" : "中期" };
    });
    const longSup = below.find(b => -b.d > LV.midPct) || null;

    // 上方結構：以容差的一半合併成獨立價位；距離以價格帶下緣計算
    const above = clusterBands(piv.filter(v => v.p > close * 1.001), tol / 2, "up").map(b => {
      const lo = tickDir(b.lo, "up", close), hi = tickDir(b.hi, "up", close);
      return { ...b, lo, hi: Math.max(lo, hi), d: pct(lo) };
    });
    const gap = (x, y) => (y - x) / x * 100;

    // 突破觀察：現價上方 10% 內最近的結構；其上同一波動容差內的結構併成同一壓力帶
    let brk = null, ext = [], used = 0, lu = null;
    if (above.length && above[0].d <= LV.nearPct) {
      const h = above[0];
      let top = h; used = 1;
      while (used < above.length && gap(h.lo, above[used].lo) <= tol) top = above[used++];
      brk = { ...h, hi: top.hi, n: above.slice(0, used).reduce((s, b) => s + b.n, 0), name: "突破觀察", zone: "近端" };
      // 近端擴展：突破觀察帶之上、間距大於容差的下一道獨立結構；超過 +10% 改標中期擴展，超過 +20% 留白
      const i = above.findIndex((b, k) => k >= used && gap(brk.hi, b.lo) > tol);
      if (i >= 0 && above[i].d <= LV.midPct) {
        ext = [{ ...above[i], name: above[i].d <= LV.nearPct ? "近端擴展" : "中期擴展", zone: above[i].d <= LV.nearPct ? "近端" : "中期" }];
        used = i + 1;
      }
    }
    const longRes = above.slice(used).find(b => b.d > LV.nearPct) || null;
    if (!above.length) lu = limitUpOf(close); // 創新高、上方沒有歷史結構
    return { status: "ok", close, th, tol, atrPct, sup, longSup, brk, ext, longRes, lu };
  }

  const LV_GROUPS = [
    { key: "support", pill: "常見接手區", icon: "🛡", color: "#14b8a6" },
    { key: "breakout", pill: "突破觀察", icon: "⚡", color: "#0ea5e9" },
    { key: "pressure", pill: "近端擴展", icon: "🔥", color: "#f97316" },
  ];
  const lvState = { on: store.get("lvOn", { support: true, breakout: true, pressure: true }), lines: [] };

  function bandText(b) { return b.lo === b.hi ? fmt(b.lo) : `${fmt(b.lo)}～${fmt(b.hi)}`; }
  function lvItem(b, color) {
    return `<li><span class="lv-dot" style="background:${color}"></span>
      <span class="lv-name">${b.name}<span class="lv-zone">${b.zone}</span></span>
      <span class="lv-price">${bandText(b)}</span>
      <span class="lv-dist ${cls(b.d)}">${sign(b.d)}${fmt(b.d, 1)}%</span>
      <span class="muted lv-n">轉折 ${b.n} 次</span></li>`;
  }

  function renderLevels() {
    if (!current) return;
    const L = current.levels;
    const box = $("#levels");
    if (L.status !== "ok") { box.innerHTML = `<div class="muted">價位結構：${L.status}。${L.note || ""}</div>`; drawLevelLines(); return; }
    const empty = msg => `<li class="muted">${msg}</li>`;
    const luItem = () => `<li><span class="lv-dot" style="background:${LV_GROUPS[1].color}"></span><span class="lv-name">明日漲停參考價<span class="lv-zone">非結構價位</span></span>
           <span class="lv-price">${fmt(L.lu)}</span><span class="lv-dist up">+${fmt((L.lu - L.close) / L.close * 100, 1)}%</span><span class="muted lv-n">創新高，上方無歷史結構</span></li>`;
    const ref = (b, why) => `<li class="muted lv-long">${why}：${bandText(b)}（${sign(b.d)}${fmt(b.d, 1)}%）</li>`;
    const body = {
      support: (L.sup.length ? L.sup.map(b => lvItem(b, LV_GROUPS[0].color)).join("")
          + (L.sup.length === 1 ? empty("目前近端沒有第二個獨立有效接手區") : "")
          : empty("近期明確接手區尚未形成（現價下方 20% 內沒有有效轉折結構）"))
        + (L.longSup ? ref(L.longSup, "長期結構參考（距現價超過 20%，不列入第一／第二常見接手區）") : ""),
      breakout: L.brk ? lvItem(L.brk, LV_GROUPS[1].color)
        : L.lu != null ? luItem()
        : empty("目前 +10% 內無明確近端壓力；較遠的價位列於中長期結構參考"),
      pressure: (L.ext.length ? L.ext.map(b => lvItem(b, LV_GROUPS[2].color)).join("")
          : empty(L.lu != null ? "上方無歷史結構，以漲停參考價為準"
            : L.brk ? "目前 +20% 內沒有突破觀察帶之上的下一道獨立結構" : "突破觀察未形成，近端擴展留白"))
        + (L.longRes ? ref(L.longRes, "中長期結構參考（超出近端擴展範圍）") : ""),
    };
    box.innerHTML = `<div class="lv-pills">${LV_GROUPS.map(g =>
      `<button class="lv-pill ${lvState.on[g.key] ? "on" : ""}" data-k="${g.key}" style="--c:${g.color}">${g.icon} ${g.pill}</button>`).join("")}
      <span class="muted lv-hint">點按切換是否畫在 K 線圖上</span></div>
      <div class="lv-cols">${LV_GROUPS.map(g => `<div class="lv-col"><div class="lv-title" style="color:${g.color}">${g.icon} ${g.pill}</div><ul>${body[g.key]}</ul></div>`).join("")}</div>`;
    $$(".lv-pill", box).forEach(b => b.onclick = () => {
      lvState.on[b.dataset.k] = !lvState.on[b.dataset.k];
      store.set("lvOn", lvState.on);
      renderLevels();
    });
    drawLevelLines();
  }

  function drawLevelLines() {
    lvState.lines.forEach(l => candle.removePriceLine(l));
    lvState.lines = [];
    const L = current?.levels;
    if (!L || L.status !== "ok") return;
    const add = (price, color, title, style = 2) => lvState.lines.push(candle.createPriceLine({
      price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
    const band = (b, color, title) => { add(b.hi, color, title); if (b.lo !== b.hi) add(b.lo, color, ""); };
    if (lvState.on.support) L.sup.forEach((b, k) => band(b, LV_GROUPS[0].color, `接手${k + 1}`));
    if (lvState.on.breakout) { if (L.brk) band(L.brk, LV_GROUPS[1].color, "突破"); else if (L.lu != null) add(L.lu, LV_GROUPS[1].color, "漲停參考", 1); }
    if (lvState.on.pressure) L.ext.forEach(b => band(b, LV_GROUPS[2].color, "擴展"));
  }

  // ---------------------------------------------------------------- 條件選股
  // test 回傳 true / false / null（null = 無法判定）
  const SC_CONDS = [
    { id: "h3", label: "月營收連續三個月創高", desc: "最近三個月營收每月都創收錄期間新高", def: "plus",
      test: s => s.rev?.h3 == null ? null : s.rev.h3 === 1 },
    { id: "mom", label: "單月營收月增", desc: "最新月營收高於上個月", def: "plus",
      test: s => s.rev?.mom == null ? null : s.rev.mom > 0 },
    { id: "h20", label: "收盤創近 20 日新高", desc: "最新收盤價高於前 19 個交易日收盤", def: "plus",
      test: s => s.f ? s.f.h20 === 1 : null },
    { id: "a3", label: "站上 5、10、20 日均線", desc: "收盤價同時高於三條均線", def: "must",
      test: s => s.f ? s.f.a3 === 1 : null },
    { id: "lu", label: "最近一日收盤漲停", desc: "收盤價達漲停價", def: "must",
      test: s => s.f ? s.f.lu === 1 : null },
    { id: "eps", label: "EPS 為正", desc: "最新已公布累計 EPS > 0；沒有 EPS 為無法判定", def: "plus",
      test: s => s.eps == null ? null : s.eps.v > 0 },
    { id: "al", label: "均線多頭排列", desc: "MA20 > MA60 > MA120", def: "off",
      test: s => s.al == null ? null : s.al === 1 },
    { id: "yoy", label: "月營收年增", desc: "最新月營收高於去年同月", def: "off",
      test: s => s.rev?.yoy == null ? null : s.rev.yoy > 0 },
  ];
  const SC_DEFAULT = Object.fromEntries(SC_CONDS.map(c => [c.id, c.def]));
  const scState = { mode: { ...SC_DEFAULT, ...store.get("scMode", {}) }, page: 0 };

  function renderScreenConds() {
    $("#screen-conds").innerHTML = SC_CONDS.map(c => `<div class="sc-cond">
      <div><div class="sc-label">${c.label}</div><div class="muted">${c.desc}</div></div>
      <div class="seg" data-id="${c.id}">${[["must", "必要"], ["plus", "加分"], ["off", "不用"]].map(([v, t]) =>
        `<button data-v="${v}" class="${scState.mode[c.id] === v ? "on " + v : ""}">${t}</button>`).join("")}</div>
    </div>`).join("");
  }
  function renderScreen() {
    const must = SC_CONDS.filter(c => scState.mode[c.id] === "must");
    const plus = SC_CONDS.filter(c => scState.mode[c.id] === "plus");
    const used = [...must, ...plus];
    const mk = $("#sc-market").value;
    const res = [];
    for (const s of state.stocks) {
      if (mk && s.m !== mk) continue;
      const r = Object.fromEntries(used.map(c => [c.id, c.test(s)]));
      if (!must.every(c => r[c.id] === true)) continue;
      res.push({ s, r, score: plus.filter(c => r[c.id] === true).length });
    }
    res.sort((a, b) => b.score - a.score || (b.s.pct ?? -99) - (a.s.pct ?? -99) || a.s.c.localeCompare(b.s.c));
    const pages = Math.max(1, Math.ceil(res.length / PAGE));
    scState.page = Math.min(scState.page, pages - 1);
    const mark = v => v === true ? '<span class="ok">✓</span>' : v === false ? '<span class="no">✗</span>' : '<span class="muted">?</span>';
    $("#sc-head").innerHTML = `<th>#</th><th>代號</th><th>名稱</th><th>產業</th><th class="r">收盤</th><th class="r">漲跌幅</th>`
      + `<th class="r">加分</th>` + used.map(c => `<th class="c" title="${c.desc}">${c.label}<br><span class="tag ${scState.mode[c.id]}">${scState.mode[c.id] === "must" ? "必要" : "加分"}</span></th>`).join("");
    $("#sc-table tbody").innerHTML = res.slice(scState.page * PAGE, (scState.page + 1) * PAGE).map((x, i) => `<tr data-c="${x.s.c}">
      <td class="muted">${scState.page * PAGE + i + 1}</td><td>${x.s.c}</td><td>${esc(x.s.n)}</td><td>${esc(x.s.ind)}</td>
      <td class="r ${cls(x.s.chg)}">${fmt(x.s.p)}</td>
      <td class="r ${cls(x.s.pct)}">${x.s.pct == null ? "—" : sign(x.s.pct) + fmt(x.s.pct) + "%"}</td>
      <td class="r"><b>${x.score}</b><span class="muted">/${plus.length}</span></td>
      ${used.map(c => `<td class="c">${mark(x.r[c.id])}</td>`).join("")}
    </tr>`).join("") || `<tr><td colspan="${7 + used.length}" class="muted" style="text-align:center;padding:30px">${used.length ? "沒有符合必要條件的股票" : "請至少選一個條件"}</td></tr>`;
    $("#sc-count").textContent = `符合 ${res.length} 檔`;
    $("#sc-pageinfo").textContent = `${scState.page + 1} / ${pages}`;
    $("#sc-prev").disabled = scState.page === 0;
    $("#sc-next").disabled = scState.page >= pages - 1;
  }
  function setScMode(mode) {
    scState.mode = mode; scState.page = 0;
    store.set("scMode", mode);
    renderScreenConds(); renderScreen();
  }

  // ---------------------------------------------------------------- 搜尋建議
  let selIdx = -1;
  function renderSuggest() {
    const q = $("#search").value.trim();
    const ul = $("#suggest");
    if (!q) { ul.hidden = true; return; }
    const list = state.stocks.filter(s => matches(s, q))
      .sort((a, b) => (b.c === q) - (a.c === q) || (b.c.startsWith(q) - a.c.startsWith(q)) || a.c.localeCompare(b.c)).slice(0, 12);
    selIdx = list.length ? 0 : -1;
    ul.innerHTML = list.map((s, i) => `<li data-c="${s.c}" class="${i === 0 ? "sel" : ""}"><b>${s.c}</b><span>${esc(s.n)}</span><span class="muted">${s.m}・${esc(s.ind)}</span></li>`).join("")
      || `<li class="muted">查無結果</li>`;
    ul.hidden = false;
    $$("li[data-c]", ul).forEach(li => li.onmousedown = e => { e.preventDefault(); pick(li.dataset.c); });
  }
  function pick(c) { $("#suggest").hidden = true; openStock(c); }

  // ---------------------------------------------------------------- 技術圖
  let chart = null, candle = null, vol = null, maSeries = {}, current = null;

  function isDark() { return matchMedia("(prefers-color-scheme: dark)").matches; }
  function sma(rows, n) {
    const out = []; let sum = 0;
    for (let i = 0; i < rows.length; i++) {
      sum += rows[i][4];
      if (i >= n) sum -= rows[i - n][4];
      if (i >= n - 1) out.push({ time: rows[i].t, value: +(sum / n).toFixed(2) });
    }
    return out;
  }

  function ensureChart() {
    if (chart) return;
    const dark = isDark();
    const css = getComputedStyle(document.documentElement);
    const up = css.getPropertyValue("--up").trim(), down = css.getPropertyValue("--down").trim();
    chart = LightweightCharts.createChart($("#chart"), {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: dark ? "#9aa3b2" : "#4b5563", fontFamily: "inherit" },
      grid: { vertLines: { color: dark ? "#232833" : "#f0f1f3" }, horzLines: { color: dark ? "#232833" : "#f0f1f3" } },
      rightPriceScale: { borderColor: dark ? "#2b313c" : "#e5e7eb" },
      timeScale: { borderColor: dark ? "#2b313c" : "#e5e7eb", rightOffset: 3 },
      crosshair: { mode: 0 },
      localization: { locale: "zh-TW", dateFormat: "yyyy-MM-dd" },
    });
    candle = chart.addCandlestickSeries({
      upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down,
      priceLineVisible: false,
    });
    candle.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.26 } });
    vol = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    for (const m of MA_DEFS) {
      maSeries[m.n] = chart.addLineSeries({ color: m.color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, visible: !!state.maOn[m.n] });
    }
    chart.subscribeCrosshairMove(p => updateLegend(p.time ? p : null));
  }

  function updateLegend(p) {
    if (!current) return;
    const rows = current.rows;
    let i = rows.length - 1;
    if (p) i = current.idx.get(p.time) ?? i;
    const r = rows[i];
    if (!r) { $("#legend").innerHTML = ""; return; }
    const prev = rows[i - 1]?.[4];
    const ch = prev ? (r[4] - prev) / prev * 100 : null;
    let html = `<span>${r.t}</span><span>開 <b>${fmt(r[1])}</b></span><span>高 <b>${fmt(r[2])}</b></span><span>低 <b>${fmt(r[3])}</b></span>
      <span>收 <b class="${cls(ch)}">${fmt(r[4])}</b></span>${ch == null ? "" : `<span class="${cls(ch)}">${sign(ch)}${fmt(ch)}%</span>`}<span>量 <b>${fmt(r[5], 0)}</b> 張</span>`;
    for (const m of MA_DEFS) {
      if (!state.maOn[m.n]) continue;
      const v = current.ma[m.n]?.get(r.t);
      html += `<span style="color:${m.color}">MA${m.n} ${v == null ? "—" : fmt(v)}</span>`;
    }
    $("#legend").innerHTML = html;
  }

  function applyRange() {
    if (!current) return;
    const n = current.rows.length;
    const r = state.range;
    if (!r || r >= n) chart.timeScale().fitContent();
    else chart.timeScale().setVisibleLogicalRange({ from: n - r, to: n + 2 });
    $$(".ranges button").forEach(b => b.classList.toggle("active", +b.dataset.range === r));
  }

  async function openStock(code) {
    const s = state.byCode.get(code);
    if (!s) return;
    $("#modal").hidden = false;
    document.body.style.overflow = "hidden";
    history.replaceState(null, "", "#" + code);
    $("#d-title").textContent = `${s.c} ${s.n}`;
    $("#d-price").innerHTML = s.p == null ? "" : `<span class="${cls(s.chg)}">${fmt(s.p)} ${s.chg == null ? "" : `${sign(s.chg)}${fmt(s.chg)} (${sign(s.pct)}${fmt(s.pct)}%)`}</span>`;
    $("#fav-btn").textContent = state.favs.has(code) ? "★" : "☆";
    const r = s.rev;
    $("#d-info").innerHTML = `<span>${s.m}・${esc(s.ind)}</span>`
      + (r ? `<span>${ymLabel(r.ym)} 營收 <b>${fmt(r.rev / 1e5)}</b> 億</span>
        <span>月增 <b class="${cls(r.mom)}">${sign(r.mom)}${fmt(r.mom)}%</b></span>
        <span>年增 <b class="${cls(r.yoy)}">${sign(r.yoy)}${fmt(r.yoy)}%</b></span>
        <span>累計年增 <b class="${cls(r.cumYoy)}">${sign(r.cumYoy)}${fmt(r.cumYoy)}%</b></span>` : "")
      + (r?.date ? `<span>公布日 <b>${mdLabel(r.date)}</b></span>` : "")
      + (s.ma ? `<span>MA20 <b>${fmt(s.ma[0])}</b>／MA60 <b>${fmt(s.ma[1])}</b>／MA120 <b>${fmt(s.ma[2])}</b> ${alBadge(s)}</span>` : "")
      + (mcap(s) != null ? `<span>市值 <b>${fmt(mcap(s), 0)}</b> 億</span>` : "");
    $("#legend").textContent = "載入中…";

    ensureChart();
    let rows;
    try {
      rows = await fetch(`data/prices/${code}.json`, { cache: "no-cache" }).then(x => { if (!x.ok) throw 0; return x.json(); });
    } catch { rows = []; }
    rows.forEach(r => { const d = String(r[0]); r.t = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`; });
    const css = getComputedStyle(document.documentElement);
    const up = css.getPropertyValue("--up").trim(), down = css.getPropertyValue("--down").trim();
    const maData = Object.fromEntries(MA_DEFS.map(m => [m.n, sma(rows, m.n)]));
    current = { s, rows, idx: new Map(rows.map((r, i) => [r.t, i])),
      ma: Object.fromEntries(MA_DEFS.map(m => [m.n, new Map(maData[m.n].map(d => [d.time, d.value]))])) };
    candle.setData(rows.map(r => ({ time: r.t, open: r[1], high: r[2], low: r[3], close: r[4] })));
    vol.setData(rows.map((r, i) => ({ time: r.t, value: r[5], color: (r[4] >= (rows[i - 1]?.[4] ?? r[1]) ? up : down) + "66" })));
    for (const m of MA_DEFS) maSeries[m.n].setData(maData[m.n]);
    if (!rows.length) $("#legend").textContent = "目前沒有這檔股票的股價資料";
    else updateLegend(null);
    current.levels = rows.length ? computeLevels(rows) : { status: "資料不足" };
    renderLevels();
    applyRange();
  }
  function closeModal() {
    $("#modal").hidden = true;
    document.body.style.overflow = "";
    history.replaceState(null, "", location.pathname + location.search);
    current = null;
  }

  function renderMaToggles() {
    $("#ma-toggles").innerHTML = MA_DEFS.map(m =>
      `<label><input type="checkbox" data-ma="${m.n}" ${state.maOn[m.n] ? "checked" : ""}><i style="background:${m.color}"></i>MA${m.n}</label>`).join("")
      + `<button class="ghost" id="ma-all" style="padding:3px 10px;border-radius:999px">全選/全不選</button>`;
    $$("#ma-toggles input").forEach(cb => cb.onchange = () => {
      state.maOn[cb.dataset.ma] = cb.checked;
      store.set("maOn", state.maOn);
      maSeries[cb.dataset.ma]?.applyOptions({ visible: cb.checked });
      updateLegend(null);
    });
    $("#ma-all").onclick = () => {
      const on = !MA_DEFS.every(m => state.maOn[m.n]);
      MA_DEFS.forEach(m => { state.maOn[m.n] = on; maSeries[m.n]?.applyOptions({ visible: on }); });
      store.set("maOn", state.maOn);
      renderMaToggles(); updateLegend(null);
    };
  }

  // ---------------------------------------------------------------- 事件
  function switchTab(t) {
    $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === t));
    $("#tab-list").hidden = t !== "list";
    $("#tab-calendar").hidden = t !== "calendar";
    $("#tab-rank").hidden = t !== "rank";
    $("#tab-screen").hidden = t !== "screen";
  }

  function bind() {
    $$(".tab").forEach(b => b.onclick = () => switchTab(b.dataset.tab));
    const search = $("#search");
    search.addEventListener("input", () => { state.page = 0; renderTable(); renderSuggest(); });
    search.addEventListener("focus", renderSuggest);
    search.addEventListener("blur", () => setTimeout(() => $("#suggest").hidden = true, 100));
    search.addEventListener("keydown", e => {
      const items = $$("#suggest li[data-c]");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!items.length) return;
        selIdx = (selIdx + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items.forEach((li, i) => li.classList.toggle("sel", i === selIdx));
        items[selIdx].scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && items[selIdx]) {
        pick(items[selIdx].dataset.c);
      } else if (e.key === "Escape") {
        $("#suggest").hidden = true;
      }
    });
    ["#f-market", "#f-ind", "#f-fav", "#f-al"].forEach(s => $(s).onchange = () => { state.page = 0; renderTable(); });
    $$("#table th[data-k]").forEach(th => th.onclick = () => {
      const k = th.dataset.k;
      if (state.sortKey === k) state.sortAsc = !state.sortAsc;
      else { state.sortKey = k; state.sortAsc = ["c", "n", "m", "ind"].includes(k); }
      renderTable();
    });
    $("#table tbody").addEventListener("click", e => {
      const fav = e.target.closest("[data-fav]");
      if (fav) { e.stopPropagation(); toggleFav(fav.dataset.fav); return; }
      const tr = e.target.closest("tr[data-c]");
      if (tr) openStock(tr.dataset.c);
    });
    $("#prev").onclick = () => { state.page--; renderTable(); window.scrollTo({ top: 0 }); };
    $("#next").onclick = () => { state.page++; renderTable(); window.scrollTo({ top: 0 }); };

    $("#cal-prev").onclick = () => shiftMonth(-1);
    $("#cal-next").onclick = () => shiftMonth(1);
    $("#cal-today").onclick = () => { state.calSel = todayStr(); state.calMonth = state.calSel.slice(0, 7); renderCalendar(); };
    $("#cal-fav").onchange = renderCalendar;
    ["#rk-metric", "#rk-market", "#rk-ind", "#rk-order", "#rk-al"].forEach(id => $(id).onchange = () => {
      if (id === "#rk-metric") store.set("rkMetric", $(id).value);
      renderRank();
    });
    $("#screen-conds").addEventListener("click", e => {
      const b = e.target.closest(".seg button");
      if (b) setScMode({ ...scState.mode, [b.parentElement.dataset.id]: b.dataset.v });
    });
    $("#sc-reset").onclick = () => setScMode({ ...SC_DEFAULT });
    $("#sc-allplus").onclick = () => setScMode(Object.fromEntries(SC_CONDS.map(c => [c.id, "plus"])));
    $("#sc-market").onchange = () => { scState.page = 0; renderScreen(); };
    $("#sc-prev").onclick = () => { scState.page--; renderScreen(); };
    $("#sc-next").onclick = () => { scState.page++; renderScreen(); };
    $("#sc-table tbody").addEventListener("click", e => {
      const tr = e.target.closest("tr[data-c]");
      if (tr) openStock(tr.dataset.c);
    });
    $("#rank-grid").addEventListener("click", e => {
      const li = e.target.closest("li[data-c]");
      if (li) openStock(li.dataset.c);
    });

    $("#close").onclick = closeModal;
    $("#modal").onclick = e => { if (e.target.id === "modal") closeModal(); };
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#modal").hidden) closeModal(); });
    $("#fav-btn").onclick = () => current && toggleFav(current.s.c);
    $$(".ranges button").forEach(b => b.onclick = () => { state.range = +b.dataset.range; store.set("range", state.range); applyRange(); });
    renderMaToggles();
    $("#rk-metric").value = store.get("rkMetric", "cap");
  }

  bind();
  load().catch(err => {
    console.error(err);
    $("#soon").innerHTML = `<b>無法載入資料。</b>請確認已執行 <code>python3 scripts/fetch_data.py</code>，並以網頁伺服器開啟（例如 <code>python3 -m http.server</code>），不能直接雙擊 HTML 檔。`;
  });
})();
