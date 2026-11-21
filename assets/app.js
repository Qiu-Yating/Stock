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
    events: [],          // {date, s, ym, type: actual|est|due}
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

  function nextInfo(s) {
    if (!s.next) return null;
    const t = s.next.overdue ? "due" : "est";
    return { date: s.next.overdue ? s.next.deadline : s.next.date, type: t, ym: s.next.ym };
  }
  function badge(type) {
    return { actual: '<span class="badge actual">已公布</span>', est: '<span class="badge est">預估</span>', due: '<span class="badge due">逾期</span>' }[type];
  }

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

    renderSoon();
    renderTable();
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
      const n = nextInfo(s);
      if (n) ev.push({ date: n.date, s, ym: n.ym, type: n.type });
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
    const dates = [...state.eventsByDate.keys()].filter(d => d >= t).sort().slice(0, 4);
    const todayActual = (state.eventsByDate.get(t) || []).filter(e => e.type === "actual");
    let html = "";
    if (todayActual.length) {
      html += `<div><b>今日已公布營收（${todayActual.length} 家）：</b>${chips(todayActual)}</div>`;
    }
    const upcoming = dates.map(d => [d, (state.eventsByDate.get(d) || []).filter(e => e.type !== "actual")]).filter(([, l]) => l.length);
    if (upcoming.length) {
      html += `<div><b>即將公布營收：</b>` + upcoming.map(([d, l]) =>
        `<span class="muted" style="font-size:13px;margin-left:6px">${mdLabel(d)} ${l.length} 家</span>`).join("") + `</div>`;
      const first = upcoming[0][1];
      html += `<div>${chips(first, 40)} <a href="#" id="soon-more" class="muted">查看行事曆 ›</a></div>`;
    }
    $("#soon").innerHTML = html;
    $$("#soon .chip").forEach(c => c.onclick = () => openStock(c.dataset.c));
    const more = $("#soon-more");
    if (more) more.onclick = e => { e.preventDefault(); state.calSel = upcoming[0][0]; state.calMonth = upcoming[0][0].slice(0, 7); switchTab("calendar"); renderCalendar(); };
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
      case "next": return nextInfo(s)?.date ?? "9999";
      case "p": case "pct": case "v": return s[k] ?? -Infinity;
      default: return s[k] ?? "";
    }
  }
  function filtered() {
    const q = $("#search").value, m = $("#f-market").value, ind = $("#f-ind").value, fav = $("#f-fav").checked;
    const list = state.stocks.filter(s => matches(s, q) && (!m || s.m === m) && (!ind || s.ind === ind) && (!fav || state.favs.has(s.c)));
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
      const n = nextInfo(s);
      const r = s.rev;
      return `<tr data-c="${s.c}">
        <td><button class="star" data-fav="${s.c}">${state.favs.has(s.c) ? "★" : "☆"}</button></td>
        <td>${s.c}</td><td>${esc(s.n)}</td><td>${s.m}</td><td>${esc(s.ind)}</td>
        <td class="r ${cls(s.chg)}">${fmt(s.p)}</td>
        <td class="r ${cls(s.pct)}">${s.pct == null ? "—" : sign(s.pct) + fmt(s.pct) + "%"}</td>
        <td class="r">${fmt(s.v, 0)}</td>
        <td>${r ? ymLabel(r.ym) + (r.date ? ` <span class="muted">${r.date.slice(5)}</span>` : "") : "—"}</td>
        <td class="r">${r ? fmt(r.rev / 1e5, 2) : "—"}</td>
        <td class="r ${cls(r?.yoy)}">${r?.yoy == null ? "—" : sign(r.yoy) + fmt(r.yoy) + "%"}</td>
        <td>${n ? mdLabel(n.date) + badge(n.type) : "—"}</td>
      </tr>`;
    }).join("");
    $("#table tbody").innerHTML = rows || `<tr><td colspan="12" class="muted" style="text-align:center;padding:30px">查無符合的股票</td></tr>`;
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
      const c = { actual: 0, est: 0, due: 0 };
      list.forEach(e => c[e.type]++);
      const top = [...list].sort((a, b) => (state.favs.has(b.s.c) - state.favs.has(a.s.c)) || (b.s.v || 0) - (a.s.v || 0)).slice(0, 3);
      html += `<div class="cell ${d.getMonth() !== m - 1 ? "other" : ""} ${ds === t ? "today" : ""} ${ds === state.calSel ? "sel" : ""}" data-d="${ds}">
        <div class="dn">${d.getDate()}</div>
        ${c.actual ? `<div class="cnt"><i class="dot actual"></i>${c.actual}</div>` : ""}
        ${c.est ? `<div class="cnt"><i class="dot est"></i>${c.est}</div>` : ""}
        ${c.due ? `<div class="cnt"><i class="dot due"></i>${c.due}</div>` : ""}
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
    const groups = [["actual", "已公布"], ["est", "預估公布"], ["due", "逾期未公布（法定期限）"]];
    let html = `<h3>${ds ? mdLabel(ds) : ""} 營收公布</h3>`;
    if (!list.length) html += `<p class="muted">這天沒有營收公布資料</p>`;
    for (const [type, label] of groups) {
      const l = list.filter(e => e.type === type).sort((a, b) => (state.favs.has(b.s.c) - state.favs.has(a.s.c)) || a.s.c.localeCompare(b.s.c));
      if (!l.length) continue;
      html += `<div class="muted">${label}（${l.length}）</div><ul>` + l.map(e => {
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
    const r = s.rev, n = nextInfo(s);
    $("#d-info").innerHTML = `<span>${s.m}・${esc(s.ind)}</span>`
      + (r ? `<span>${ymLabel(r.ym)} 營收 <b>${fmt(r.rev / 1e5)}</b> 億</span>
        <span>月增 <b class="${cls(r.mom)}">${sign(r.mom)}${fmt(r.mom)}%</b></span>
        <span>年增 <b class="${cls(r.yoy)}">${sign(r.yoy)}${fmt(r.yoy)}%</b></span>
        <span>累計年增 <b class="${cls(r.cumYoy)}">${sign(r.cumYoy)}${fmt(r.cumYoy)}%</b></span>` : "")
      + (n ? `<span>下次營收（${ymLabel(n.ym)}）：<b>${mdLabel(n.date)}</b>${badge(n.type)}</span>` : "");
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
    ["#f-market", "#f-ind", "#f-fav"].forEach(s => $(s).onchange = () => { state.page = 0; renderTable(); });
    $$("#table th[data-k]").forEach(th => th.onclick = () => {
      const k = th.dataset.k;
      if (state.sortKey === k) state.sortAsc = !state.sortAsc;
      else { state.sortKey = k; state.sortAsc = ["c", "n", "m", "ind", "next", "revYm"].includes(k); }
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

    $("#close").onclick = closeModal;
    $("#modal").onclick = e => { if (e.target.id === "modal") closeModal(); };
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#modal").hidden) closeModal(); });
    $("#fav-btn").onclick = () => current && toggleFav(current.s.c);
    $$(".ranges button").forEach(b => b.onclick = () => { state.range = +b.dataset.range; store.set("range", state.range); applyRange(); });
    renderMaToggles();
  }

  bind();
  load().catch(err => {
    console.error(err);
    $("#soon").innerHTML = `<b>無法載入資料。</b>請確認已執行 <code>python3 scripts/fetch_data.py</code>，並以網頁伺服器開啟（例如 <code>python3 -m http.server</code>），不能直接雙擊 HTML 檔。`;
  });
})();
