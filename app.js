/* ==========================================================================
   油镜 OILSCOPE — app.js
   数据：window.OIL_SNAPSHOT（由 data/data.js 注入）
   ========================================================================== */
(function () {
  "use strict";

  const FUELS = [
    { key: "92", name: "92 号汽油", short: "92#" },
    { key: "95", name: "95 号汽油", short: "95#" },
    { key: "98", name: "98 号汽油", short: "98#" },
    { key: "0", name: "0 号柴油", short: "0#" },
  ];

  const EXTRA_MAP = [
    ["89", "89#"],
    ["e92", "92#乙醇"],
    ["e95", "95#乙醇"],
    ["e98", "98#乙醇"],
    ["ap95", "爱跑95"],
    ["ap98", "爱跑98"],
    ["10h", "-10#柴油"],
    ["20h", "-20#柴油"],
    ["35h", "-35#柴油"],
    ["zyk", "站库柴油"],
  ];

  // 省份在“地图”上的网格位置：[列, 行, 是否横跨两列]（9 × 8 的瓦片地图）
  const MAP_POS = {
    内蒙古: [4, 1, true],
    黑龙江: [8, 1],
    新疆: [1, 2, true],
    甘肃: [3, 2],
    宁夏: [4, 2],
    北京: [6, 2],
    天津: [7, 2],
    吉林: [8, 2],
    青海: [3, 3],
    陕西: [4, 3],
    山西: [5, 3],
    河北: [6, 3],
    辽宁: [7, 3],
    西藏: [2, 4],
    四川: [3, 4],
    重庆: [4, 4],
    河南: [5, 4],
    山东: [6, 4],
    贵州: [3, 5],
    湖北: [4, 5],
    安徽: [5, 5],
    江苏: [6, 5],
    云南: [2, 6],
    广西: [3, 6],
    湖南: [4, 6],
    江西: [5, 6],
    浙江: [6, 6],
    上海: [7, 6],
    广东: [3, 7],
    福建: [5, 7],
    海南: [4, 8],
  };

  const API_BASE =
    (window.OIL_CONFIG && window.OIL_CONFIG.endpoint) ||
    "https://cn.apihz.cn/api/jinrong/youjia.php";
  const API_ID =
    (window.OIL_CONFIG && window.OIL_CONFIG.id) || "88888888";
  const API_KEY =
    (window.OIL_CONFIG && window.OIL_CONFIG.key) || "88888888";
  const CACHE_KEY = "oilscope:cache:v1";
  const PREF_KEY = "oilscope:pref:v1";
  const TANK = 50;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  let SNAPSHOT = null;
  let tiles = {};
  let refreshing = false;

  const state = {
    province: "四川",
    zone: 0,
    fuel: "92",
    mapFuel: "92",
    sortKey: "92",
    sortDir: "desc",
    query: "",
    calcProvince: "四川",
    calcFuel: "92",
    calcLiters: 50,
    lastSync: null,
  };

  const reducedMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- helpers ---------- */
  const fmt = (n) => (n == null || !Number.isFinite(+n) ? "—" : (+n).toFixed(2));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function dateDigits(str) {
    const m = /(\d{4})\D+(\d{1,2})\D+(\d{1,2})/.exec(String(str || ""));
    return m ? `${m[1]}${String(m[2]).padStart(2, "0")}${String(m[3]).padStart(2, "0")}` : "";
  }

  function dateShort(str) {
    const d = dateDigits(str);
    return d ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}` : String(str || "—");
  }

  function headDate(str) {
    const d = dateDigits(str);
    return d ? `${+d.slice(4, 6)} 月 ${+d.slice(6, 8)} 日调价` : "调价日期未知";
  }

  function toPrice(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function toChange(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function latestDate() {
    let latest = SNAPSHOT.date || "";
    Object.values(SNAPSHOT.provinces).forEach((p) => {
      if (dateDigits(p.date) > dateDigits(latest)) latest = p.date;
    });
    return latest;
  }

  function provinces() {
    return Object.keys(SNAPSHOT.provinces);
  }

  function getProvince(name) {
    return SNAPSHOT.provinces[name || state.province] || null;
  }

  function getZone(name, zoneIndex) {
    const p = getProvince(name);
    if (!p || !p.zones || !p.zones.length) return null;
    const idx = Math.min(Math.max(zoneIndex == null ? state.zone : zoneIndex, 0), p.zones.length - 1);
    return p.zones[idx];
  }

  function priceOf(name, fuel, zoneIndex) {
    const p = getProvince(name);
    if (!p) return null;
    if (zoneIndex != null) {
      const z = getZone(name, zoneIndex);
      return z ? z.prices[fuel] : null;
    }
    for (let i = 0; i < p.zones.length; i += 1) {
      if (p.zones[i].prices[fuel] != null) return p.zones[i].prices[fuel];
    }
    return null;
  }

  function changeOf(name, fuel, zoneIndex) {
    const p = getProvince(name);
    if (!p) return null;
    if (zoneIndex != null) {
      const z = getZone(name, zoneIndex);
      return z ? z.changes[fuel] : null;
    }
    for (let i = 0; i < p.zones.length; i += 1) {
      if (p.zones[i].prices[fuel] != null) return p.zones[i].changes[fuel];
    }
    return null;
  }

  function allValues(fuel) {
    return provinces()
      .map((name) => ({ name, value: priceOf(name, fuel) }))
      .filter((d) => d.value != null);
  }

  function deltaClass(v) {
    return v == null || Math.abs(v) < 0.005 ? "flat" : v > 0 ? "up" : "down";
  }

  function deltaText(v) {
    if (v == null) return "暂无";
    if (Math.abs(v) < 0.005) return "持平";
    return `${v > 0 ? "↑" : "↓"} ${Math.abs(v).toFixed(2)}`;
  }

  function deltaHtml(v, prefix) {
    return `<span class="delta ${deltaClass(v)}">${prefix ? prefix + " " : ""}${deltaText(v)}</span>`;
  }

  /* ---------- data normalization ---------- */
  function normalizeProvince(raw, provinceName) {
    const keys = Object.keys((raw && raw.data) || {}).sort((a, b) => {
      const na = parseInt(String(a).replace(/\D/g, ""), 10) || 0;
      const nb = parseInt(String(b).replace(/\D/g, ""), 10) || 0;
      return na - nb;
    });

    let zones = keys.map((k, i) => {
      const z = raw.data[k] || {};
      let p92 = toPrice(z["92"]);
      let p95 = toPrice(z["95"]);
      let p98 = toPrice(z["98"]);
      let c92 = toChange(z["92bd"]);
      let c95 = toChange(z["95bd"]);
      let c98 = toChange(z["98bd"]);
      let ethanol = false;

      // 河南等推广乙醇汽油的地区，源数据只有 E92/E95
      if (p92 == null && toPrice(z.e92) != null) {
        p92 = toPrice(z.e92); c92 = toChange(z.e92bd); ethanol = true;
      }
      if (p95 == null && toPrice(z.e95) != null) {
        p95 = toPrice(z.e95); c95 = toChange(z.e95bd); ethanol = true;
      }
      if (p98 == null && toPrice(z.e98) != null) {
        p98 = toPrice(z.e98); c98 = toChange(z.e98bd); ethanol = true;
      }

      const extras = {};
      EXTRA_MAP.forEach(([key, label]) => {
        const v = toPrice(z[key]);
        if (v == null) return;
        if (ethanol && (key === "e92" || key === "e95" || key === "e98")) return;
        extras[label] = v;
      });

      return {
        name: z.jq || `${i + 1} 价区`,
        area: z.area || "",
        prices: { 92: p92, 95: p95, 98: p98, 0: toPrice(z["0h"]) },
        changes: { 92: c92, 95: c95, 98: c98, 0: toChange(z["0hbd"]) },
        ethanol,
        extras,
      };
    });

    // 陕西：源数据把汽油、柴油拆成独立“价区”，合并为地区价区
    if (zones.some((z) => /^汽油价格/.test(z.name)) && zones.some((z) => /^柴油价格/.test(z.name))) {
      const gasZones = zones.filter((z) => /^汽油价格/.test(z.name));
      const dieselZones = zones.filter((z) => /^柴油价格/.test(z.name));
      const diesel = dieselZones.find((z) => /其他/.test(z.name)) || dieselZones[0];
      const around = dieselZones.find((z) => /绕城/.test(z.name));
      zones = gasZones.map((z) => {
        const merged = {
          ...z,
          name: z.name.replace(/^汽油价格[:：]\s*/, ""),
          prices: { ...z.prices, 0: diesel ? diesel.prices["0"] : null },
          changes: { ...z.changes, 0: diesel ? diesel.changes["0"] : null },
          extras: { ...z.extras },
        };
        if (around && around.prices["0"] != null) {
          merged.extras["西安绕城内 0#"] = around.prices["0"];
        }
        return merged;
      });
    }

    zones = zones.filter((z) => Object.values(z.prices).some((v) => v != null));
    if (!zones.length) {
      zones = [{
        name: "暂无报价",
        area: "数据源暂未收录该省报价",
        prices: { 92: null, 95: null, 98: null, 0: null },
        changes: { 92: null, 95: null, 98: null, 0: null },
        ethanol: false,
        extras: {},
      }];
    }

    return { date: raw.date || "", zones };
  }

  function mergeCache() {
    let cache;
    try {
      cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    } catch (e) {
      return;
    }
    if (!cache || !cache.provinces) return;
    Object.keys(cache.provinces).forEach((name) => {
      const cached = cache.provinces[name];
      const current = SNAPSHOT.provinces[name];
      if (!cached || !cached.zones || !cached.zones.length) return;
      if (!current || dateDigits(cached.date) >= dateDigits(current.date)) {
        SNAPSHOT.provinces[name] = cached;
      }
    });
    if (cache.savedAt) state.lastSync = cache.savedAt;
  }

  function saveCache(provinceName, provinceData) {
    try {
      const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "null") || { provinces: {} };
      cache.savedAt = new Date().toISOString();
      cache.provinces = cache.provinces || {};
      cache.provinces[provinceName] = provinceData;
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
      state.lastSync = cache.savedAt;
    } catch (e) {
      /* 存储不可用时忽略 */
    }
  }

  function savePref() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({ province: state.province, fuel: state.fuel }));
    } catch (e) { /* ignore */ }
  }

  function loadPref() {
    try {
      const p = JSON.parse(localStorage.getItem(PREF_KEY) || "null");
      if (p && SNAPSHOT.provinces[p.province]) state.province = p.province;
      if (p && FUELS.some((f) => f.key === p.fuel)) state.fuel = p.fuel;
    } catch (e) { /* ignore */ }
  }

  /* ---------- regional picker ---------- */
  function renderPickerList(query) {
    const q = (query || "").trim();
    const list = provinces().filter((name) => !q || name.includes(q) || name.replace(/省|市|自治区|壮族|回族|维吾尔/g, "").includes(q));
    const box = $("#regionList");
    if (!list.length) {
      box.innerHTML = `<div style="grid-column:1/-1;padding:16px;color:var(--dim);font-size:12.5px;text-align:center">没有找到匹配的地区</div>`;
      return;
    }
    box.innerHTML = list.map((name) => {
      const p = priceOf(name, "92");
      return `<button type="button" class="region-item" role="option" data-prov="${escapeHtml(name)}"
        aria-selected="${name === state.province}">
        <span>${escapeHtml(name)}</span><span class="p">${fmt(p)}</span>
      </button>`;
    }).join("");
  }

  function openPicker() {
    $("#regionPop").hidden = false;
    $("#regionTrigger").setAttribute("aria-expanded", "true");
    $("#regionSearch").value = "";
    renderPickerList("");
    setTimeout(() => $("#regionSearch").focus(), 30);
  }

  function closePicker() {
    $("#regionPop").hidden = true;
    $("#regionTrigger").setAttribute("aria-expanded", "false");
  }

  function togglePicker() {
    if ($("#regionPop").hidden) openPicker();
    else closePicker();
  }

  /* ---------- select ---------- */
  function selectProvince(name, opts) {
    if (!SNAPSHOT.provinces[name]) return;
    state.province = name;
    state.zone = 0;
    state.calcProvince = name;
    savePref();
    renderAll();
    if (opts && opts.toast) toast(`已切换到 ${name}`);
  }

  function cycleZone() {
    const p = getProvince();
    if (!p || p.zones.length < 2) return;
    state.zone = (state.zone + 1) % p.zones.length;
    renderTicket();
    const z = getZone();
    toast(`${p.zones[state.zone].name}${z && z.area ? " · " + z.area : ""}`);
  }

  /* ---------- render: ticket ---------- */
  function renderTicket() {
    const p = getProvince();
    if (!p) return;
    state.zone = Math.min(state.zone, p.zones.length - 1);
    const zone = getZone();
    if (!zone) return;

    const fuelDef = FUELS.find((f) => f.key === state.fuel) || FUELS[0];
    const noData = p.zones.length === 1 && p.zones[0].name === "暂无报价";
    const price = zone.prices[state.fuel];

    $("#ticketProvince").textContent = state.province;
    $("#ticketFuel").textContent = noData
      ? "省级报价"
      : zone.ethanol && fuelDef.key !== "0"
        ? `${fuelDef.name}（乙醇）`
        : fuelDef.name;

    animatePrice($("#ticketPrice"), price);

    const chg = zone.changes[state.fuel];
    const dEl = $("#ticketDelta");
    dEl.className = `delta ${deltaClass(chg)}`;
    dEl.textContent = noData
      ? "数据源暂未收录该省报价"
      : price == null
        ? "该价区暂无此油品"
        : `较上轮 ${deltaText(chg)}`;

    $("#ticketFill").textContent = price == null ? "¥—" : `¥${(price * TANK).toFixed(2)}`;

    const kicker = $("#ticketKicker");
    if (noData) {
      kicker.textContent = "NO DATA / 暂无报价";
      kicker.className = "ticket-kicker stale";
    } else if (!p.date) {
      kicker.textContent = "DATA — / 日期未知";
      kicker.className = "ticket-kicker stale";
    } else {
      const stale = dateDigits(p.date) < dateDigits(latestDate());
      kicker.textContent = `DATA ${dateShort(p.date)} / ${stale ? "数据滞后" : "零售挂牌价"}`;
      kicker.className = `ticket-kicker${stale ? " stale" : ""}`;
    }

    const zoneBtn = $("#ticketZone");
    zoneBtn.textContent = noData ? "暂无报价" : zone.name;
    zoneBtn.disabled = p.zones.length < 2;
    zoneBtn.title = noData
      ? "数据源暂未收录该省报价"
      : p.zones.length > 1
        ? `点击切换价区${zone.area ? "：" + zone.area : ""}`
        : "该省执行统一价格";

    const area = $("#ticketArea");
    if (noData) {
      area.hidden = false;
      area.textContent = "数据源本轮未返回该省价格，暂不参与全国均价与排行。";
    } else if (zone.area) {
      area.hidden = false;
      area.textContent = `适用范围：${zone.area}`;
    } else {
      area.hidden = true;
      area.textContent = "";
    }

    $("#ticketGrid").innerHTML = FUELS.map((f) => {
      const v = zone.prices[f.key];
      const c = zone.changes[f.key];
      return `<button type="button" class="ticket-cell" data-fuel="${f.key}"
        aria-pressed="${state.fuel === f.key}" aria-label="${f.name} ${fmt(v)} 元每升">
        <span class="k">${f.short}</span>
        <span class="v">${fmt(v)}</span>
        <span class="d ${v == null ? "flat" : deltaClass(c)}">${v == null ? "—" : deltaText(c)}</span>
      </button>`;
    }).join("");

    const extraEntries = Object.entries(zone.extras || {});
    const extraEl = $("#ticketExtra");
    if (extraEntries.length && !noData) {
      extraEl.hidden = false;
      extraEl.innerHTML = `<span class="extra-label">其他油品</span>` +
        extraEntries.map(([label, v]) => `<span>${escapeHtml(label)}<b>${fmt(v)}</b></span>`).join("");
    } else {
      extraEl.hidden = true;
      extraEl.innerHTML = "";
    }

    const d = dateDigits(p.date);
    $("#ticketCode").innerHTML = `NO. ${d || "—"}<br>ZONE ${String(state.zone + 1).padStart(2, "0")} · ${p.zones.length} ZONE${p.zones.length > 1 ? "S" : ""}`;
  }

  function animatePrice(el, target) {
    if (target == null) {
      el.textContent = "—";
      return;
    }
    const from = parseFloat(el.textContent);
    if (reducedMotion || !Number.isFinite(from) || Math.abs(from - target) < 0.005) {
      el.textContent = target.toFixed(2);
      return;
    }
    const start = performance.now();
    const dur = 420;
    function frame(now) {
      const t = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      el.textContent = (from + (target - from) * e).toFixed(2);
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /* ---------- render: stats ---------- */
  function renderStats() {
    const values = allValues("92");
    if (!values.length) return;
    const avg = values.reduce((s, d) => s + d.value, 0) / values.length;
    const sorted = values.slice().sort((a, b) => b.value - a.value);
    const high = sorted[0];
    const low = sorted[sorted.length - 1];
    const spread = high.value - low.value;

    $("#statAvg").textContent = avg.toFixed(2);
    $("#statAvgSub").textContent = `${values.length} 省算术平均 · 数据日 ${dateShort(latestDate())}`;
    $("#statHighProv").textContent = high.name;
    $("#statHigh").textContent = high.value.toFixed(2);
    $("#statHighSub").textContent = `较均价 +${(high.value - avg).toFixed(2)} 元`;
    $("#statLowProv").textContent = low.name;
    $("#statLow").textContent = low.value.toFixed(2);
    $("#statLowSub").textContent = `较均价 −${(avg - low.value).toFixed(2)} 元`;
    $("#statSpread").textContent = spread.toFixed(2);
    $("#statSpreadSub").textContent = `加满 50L 相差 ¥${(spread * TANK).toFixed(2)}`;

    $("#headDate").textContent = headDate(latestDate());
    $("#footDate").textContent = `数据日期 ${dateShort(latestDate())}`;
    $("#footUpdated").textContent =
      `SNAPSHOT · ${dateShort(latestDate())}` +
      (state.lastSync ? ` / SYNC ${new Date(state.lastSync).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : "");
  }

  /* ---------- render: map ---------- */
  function buildMap() {
    const map = $("#chinaMap");
    map.innerHTML = provinces().map((name) => {
      const pos = MAP_POS[name] || [5, 4];
      const wide = pos[2] ? " wide" : "";
      return `<button type="button" class="prov${wide}" data-prov="${escapeHtml(name)}"
        style="grid-column:${pos[0]} / span ${pos[2] ? 2 : 1};grid-row:${pos[1]}"
        aria-label="${escapeHtml(name)} 油价">
        <span class="pname">${escapeHtml(name)}</span>
        <span class="pprice">—</span>
      </button>`;
    }).join("");
    tiles = {};
    $$(".prov", map).forEach((el) => { tiles[el.dataset.prov] = el; });
  }

  function heatColor(value, avg, maxAbs) {
    const d = maxAbs > 0 ? (value - avg) / maxAbs : 0;
    if (d >= 0) {
      const e = Math.pow(d, 0.45);
      const l = 16 + 39 * e;
      return {
        bg: `hsl(43 ${(20 + 74 * e).toFixed(0)}% ${l.toFixed(0)}%)`,
        fg: l > 45 ? "#1b1205" : "#f6efdf",
      };
    }
    const e = Math.pow(-d, 0.45);
    return {
      bg: `hsl(168 ${(16 + 46 * e).toFixed(0)}% ${(13 + 20 * e).toFixed(0)}%)`,
      fg: "#e9f6f0",
    };
  }

  function renderMap() {
    const fuel = state.mapFuel;
    const values = allValues(fuel);
    const nums = values.map((d) => d.value).sort((a, b) => a - b);
    const min = nums.length ? nums[0] : 0;
    const max = nums.length ? nums[nums.length - 1] : 0;
    const avg = nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : 0;
    const maxAbs = Math.max(max - avg, avg - min, 0.01);

    provinces().forEach((name) => {
      const el = tiles[name];
      if (!el) return;
      const v = priceOf(name, fuel);
      const priceEl = $(".pprice", el);
      if (v == null) {
        el.style.background = "rgba(255,255,255,.04)";
        el.style.color = "#6a7170";
        el.style.borderColor = "rgba(255,255,255,.08)";
        el.style.backgroundImage = "repeating-linear-gradient(135deg, transparent 0 5px, rgba(255,255,255,.045) 5px 6px)";
        priceEl.textContent = "—";
        el.title = `${name}：暂无 ${fuel === "0" ? "0# 柴油" : fuel + "#"} 报价`;
      } else {
        const c = heatColor(v, avg, maxAbs);
        el.style.background = c.bg;
        el.style.backgroundImage = "none";
        el.style.color = c.fg;
        el.style.borderColor = "rgba(255,255,255,.13)";
        priceEl.textContent = v.toFixed(2);
        el.title = `${name} ${fuel === "0" ? "0# 柴油" : fuel + "#"}：${v.toFixed(2)} 元/升`;
      }
      el.classList.toggle("is-active", name === state.province);
    });

    $("#legendMin").textContent = nums.length ? min.toFixed(2) : "—";
    $("#legendMax").textContent = nums.length ? max.toFixed(2) : "—";
    const avgEl = $("#legendAvg");
    if (avgEl) avgEl.textContent = nums.length ? `均价 ${avg.toFixed(2)}` : "均价 —";
  }

  /* ---------- render: ranking ---------- */
  function renderRank() {
    const fuel = state.mapFuel;
    const fuelName = fuel === "0" ? "0# 柴油" : `${fuel}#`;
    const values = allValues(fuel).sort((a, b) => b.value - a.value);
    $("#rankHighTitle").textContent = `${fuelName} 价格高地`;
    $("#rankLowTitle").textContent = `${fuelName} 价格洼地`;

    const min = values.length ? values[values.length - 1].value : 0;
    const max = values.length ? values[0].value : 0;
    const high = values.slice(0, 5);
    const low = values.slice(-5).reverse();

    const row = (d, idx, i, isLow) => {
      const t = max > min ? (d.value - min) / (max - min) : 0.5;
      const w = (isLow ? 1 - t : t) * 80 + 20;
      return `<li class="rank-row${isLow ? " low" : ""}" data-prov="${escapeHtml(d.name)}" tabindex="0" role="button" aria-label="查看 ${escapeHtml(d.name)} 油价">
        <span class="idx">${String(i + 1).padStart(2, "0")}</span>
        <span class="nm">${escapeHtml(d.name)}</span>
        <span class="pr">${d.value.toFixed(2)}</span>
        <span class="bar"><i style="width:${w.toFixed(1)}%"></i></span>
      </li>`;
    };

    $("#rankHigh").innerHTML = high.map((d, i) => row(d, i, i, false)).join("");
    $("#rankLow").innerHTML = low.map((d, i) => row(d, i, values.length - 5 + i, true)).join("");

    if (high.length) {
      const spread = high[0].value - low[0].value;
      const coverage = values.length < provinces().length ? ` 共 ${values.length} 个地区有报价。` : "";
      $("#rankNote").innerHTML = `${fuelName} 最高为 <b>${escapeHtml(high[0].name)} ${high[0].value.toFixed(2)}</b>，最低为 <b>${escapeHtml(low[0].name)} ${low[0].value.toFixed(2)}</b>，相差 <b>¥${spread.toFixed(2)}/L</b>；加满 50L 相差 <b>¥${(spread * TANK).toFixed(2)}</b>。${coverage}`;
    } else {
      $("#rankNote").textContent = "该油品暂无可用报价。";
    }
  }

  /* ---------- render: table ---------- */
  function sortRows(rows) {
    const key = state.sortKey;
    const dir = state.sortDir === "asc" ? 1 : -1;
    return rows.sort((a, b) => {
      if (key === "name") return a.name.localeCompare(b.name, "zh-CN") * dir;
      let av, bv;
      if (key === "92chg") {
        av = changeOf(a.name, "92");
        bv = changeOf(b.name, "92");
      } else {
        av = priceOf(a.name, key);
        bv = priceOf(b.name, key);
      }
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * dir;
    });
  }

  function renderTable() {
    const q = state.query.trim();
    const rows = provinces()
      .map((name) => ({ name, prov: SNAPSHOT.provinces[name] }))
      .filter((r) => {
        if (!q) return true;
        if (r.name.includes(q)) return true;
        return r.prov.zones.some((z) => z.name.includes(q) || (z.area || "").includes(q));
      });

    sortRows(rows);

    if (!rows.length) {
      $("#tableBody").innerHTML = `<tr><td colspan="7" style="text-align:center;padding:34px;color:var(--dim);font-family:var(--font)">没有找到匹配的地区</td></tr>`;
    } else {
      $("#tableBody").innerHTML = rows.map((r) => {
        const p = r.prov;
        const multi = p.zones.length > 1;
        const noData = p.zones.length === 1 && p.zones[0].name === "暂无报价";
        const stale = !noData && p.date && dateDigits(p.date) < dateDigits(latestDate());
        const zoneLabel = multi ? `${p.zones.length} 个价区` : p.zones[0].name;
        const zoneTitle = p.zones.map((z) => z.name + (z.area ? `（${z.area}）` : "")).join("；");
        const chg = changeOf(r.name, "92");
        const flag = noData
          ? `<span class="flag">无数据</span>`
          : stale
            ? `<span class="flag" title="该省数据日期 ${escapeHtml(p.date)}">滞后</span>`
            : "";
        return `<tr data-prov="${escapeHtml(r.name)}" class="${r.name === state.province ? "is-active" : ""}" tabindex="0">
          <td><div class="region-cell"><span class="dot"></span><b>${escapeHtml(r.name)}</b>${flag}</div></td>
          <td><span class="zone-tag" title="${escapeHtml(zoneTitle)}">${escapeHtml(zoneLabel)}</span></td>
          <td class="td-price ${priceOf(r.name, "92") == null ? "na" : ""}">${fmt(priceOf(r.name, "92"))}</td>
          <td class="td-price ${priceOf(r.name, "95") == null ? "na" : ""}">${fmt(priceOf(r.name, "95"))}</td>
          <td class="td-price ${priceOf(r.name, "98") == null ? "na" : ""}">${fmt(priceOf(r.name, "98"))}</td>
          <td class="td-price ${priceOf(r.name, "0") == null ? "na" : ""}">${fmt(priceOf(r.name, "0"))}</td>
          <td class="td-change ${deltaClass(chg)}">${deltaText(chg)}</td>
        </tr>`;
      }).join("");
    }

    $("#tableCount").textContent = `${rows.length} 个地区`;

    $$("thead th.sortable").forEach((th) => {
      const k = th.dataset.sort;
      const active = k === state.sortKey;
      th.classList.toggle("sorted", active);
      th.setAttribute("aria-sort", active ? (state.sortDir === "asc" ? "ascending" : "descending") : "none");
      const arrow = $(".arrow", th);
      if (arrow) arrow.textContent = active ? (state.sortDir === "asc" ? "↑" : "↓") : "↕";
    });
  }

  /* ---------- render: calculator ---------- */
  function renderCalcOptions() {
    const sel = $("#calcProvince");
    sel.innerHTML = provinces().map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
    sel.value = state.calcProvince;
  }

  function renderCalc() {
    const p = SNAPSHOT.provinces[state.calcProvince] || getProvince();
    if (!p) return;
    const price = priceOf(state.calcProvince, state.calcFuel);
    const chg = changeOf(state.calcProvince, state.calcFuel);
    const liters = state.calcLiters;

    $("#calcLitersOut").textContent = `${liters} L`;
    const pct = ((liters - 10) / (120 - 10)) * 100;
    $("#calcLiters").style.setProperty("--fill", `${pct}%`);

    const totalEl = $("#calcTotal");
    if (price == null) {
      totalEl.textContent = "¥—";
      $("#calcDetail").textContent = `${state.calcProvince} 暂无 ${state.calcFuel === "0" ? "0# 柴油" : state.calcFuel + "#"} 报价`;
      $("#calcDelta").textContent = "—";
      $("#calcDelta").className = "";
    } else {
      totalEl.textContent = `¥${(price * liters).toFixed(2)}`;
      $("#calcDetail").textContent = `${state.calcFuel === "0" ? "0# 柴油" : state.calcFuel + "#"} ${price.toFixed(2)} 元/升 × ${liters}L`;
      const diff = chg == null ? 0 : chg * liters;
      const el = $("#calcDelta");
      if (Math.abs(diff) < 0.005) {
        el.textContent = "持平";
        el.className = "";
      } else {
        el.textContent = `${diff > 0 ? "+" : "−"}¥${Math.abs(diff).toFixed(2)}`;
        el.className = diff > 0 ? "up" : "down";
      }
    }

    $$("#calcFuel button").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.fuel === state.calcFuel));
    });
    $("#calcProvince").value = state.calcProvince;
  }

  /* ---------- render all ---------- */
  function renderAll() {
    renderTicket();
    renderStats();
    renderMap();
    renderRank();
    renderTable();
    renderCalcOptions();
    renderCalc();
    const label = state.province;
    const p = getProvince();
    const zone = getZone();
    $("#regionLabel").textContent = zone && p.zones.length > 1 ? `${label} · ${zone.name}` : label;
    $$("#quickChips button").forEach((b) => {
      b.classList.toggle("on", b.dataset.prov === state.province);
    });
  }

  /* ---------- toast ---------- */
  let toastTimer;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  /* ---------- live refresh ---------- */
  async function fetchProvince(name) {
    const url = `${API_BASE}?id=${encodeURIComponent(API_ID)}&key=${encodeURIComponent(API_KEY)}&sheng=${encodeURIComponent(name)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      if (!res.ok) throw new Error(`网络请求失败（${res.status}）`);
      let data;
      try {
        data = await res.json();
      } catch (e) {
        throw new Error("数据源返回格式异常");
      }
      if (data && data.code === 200) return data;
      const m = /请\s*(\d+)\s*秒/.exec((data && data.msg) || "");
      throw new Error(m ? `数据源繁忙，约 ${m[1]} 秒后再试` : (data && data.msg) || "数据源返回异常");
    } finally {
      clearTimeout(timer);
    }
  }

  async function refreshSelected() {
    if (refreshing) return;
    refreshing = true;
    const btn = $("#refreshBtn");
    btn.classList.add("is-loading");
    btn.disabled = true;

    try {
      const raw = await fetchProvince(state.province);
      const normalized = normalizeProvince(raw);
      const hasPrices = normalized.zones.some((z) => Object.values(z.prices).some((v) => v != null));
      if (!hasPrices) throw new Error("数据源暂未返回报价，已保留本地快照");
      SNAPSHOT.provinces[state.province] = normalized;
      state.zone = Math.min(state.zone, normalized.zones.length - 1);
      saveCache(state.province, normalized);
      renderAll();
      toast(`${state.province}油价已更新 · ${dateShort(normalized.date)}`);
    } catch (err) {
      let msg = err && err.name === "AbortError" ? "连接超时，请稍后再试" : (err.message || "刷新失败");
      if (location.protocol === "file:") msg += "；如持续失败，请用「start.bat」通过本地服务打开";
      toast(msg);
    } finally {
      refreshing = false;
      btn.classList.remove("is-loading");
      btn.disabled = false;
    }
  }

  /* ---------- events ---------- */
  function bindEvents() {
    $("#regionTrigger").addEventListener("click", togglePicker);
    $("#regionSearch").addEventListener("input", (e) => renderPickerList(e.target.value));
    $("#regionSearch").addEventListener("keydown", (e) => {
      if (e.key === "Escape") { closePicker(); $("#regionTrigger").focus(); }
      if (e.key === "Enter") {
        const first = $("#regionList .region-item");
        if (first) { selectProvince(first.dataset.prov); closePicker(); $("#regionTrigger").focus(); }
      }
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".region-pick")) closePicker();
    });

    $("#regionList").addEventListener("click", (e) => {
      const item = e.target.closest(".region-item");
      if (!item) return;
      selectProvince(item.dataset.prov);
      closePicker();
      $("#regionTrigger").focus();
    });

    $("#quickChips").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-prov]");
      if (b) selectProvince(b.dataset.prov);
    });

    $("#ticketZone").addEventListener("click", cycleZone);

    $("#ticketGrid").addEventListener("click", (e) => {
      const b = e.target.closest(".ticket-cell");
      if (!b) return;
      state.fuel = b.dataset.fuel;
      savePref();
      renderTicket();
      $("#ticketFuel").textContent = (FUELS.find((f) => f.key === state.fuel) || FUELS[0]).name;
    });

    $("#mapFuel").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-fuel]");
      if (!b) return;
      state.mapFuel = b.dataset.fuel;
      $$("#mapFuel button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      renderMap();
      renderRank();
    });

    $("#chinaMap").addEventListener("click", (e) => {
      const b = e.target.closest(".prov");
      if (b) selectProvince(b.dataset.prov);
    });

    const rankSelect = (e) => {
      const row = e.target.closest(".rank-row");
      if (!row) return;
      if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
      if (e.type === "keydown") e.preventDefault();
      selectProvince(row.dataset.prov);
      window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
    };
    $("#rankHigh").addEventListener("click", rankSelect);
    $("#rankLow").addEventListener("click", rankSelect);
    $("#rankHigh").addEventListener("keydown", rankSelect);
    $("#rankLow").addEventListener("keydown", rankSelect);

    $("#tableSearch").addEventListener("input", (e) => {
      state.query = e.target.value;
      renderTable();
    });

    $$("thead th.sortable").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        else {
          state.sortKey = key;
          state.sortDir = key === "name" ? "asc" : "desc";
        }
        renderTable();
      });
    });

    $("#tableBody").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-prov]");
      if (tr) selectProvince(tr.dataset.prov);
    });
    $("#tableBody").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const tr = e.target.closest("tr[data-prov]");
      if (tr) { e.preventDefault(); selectProvince(tr.dataset.prov); }
    });

    $("#calcProvince").addEventListener("change", (e) => {
      state.calcProvince = e.target.value;
      renderCalc();
    });

    $("#calcFuel").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-fuel]");
      if (!b) return;
      state.calcFuel = b.dataset.fuel;
      renderCalc();
    });

    $("#calcLiters").addEventListener("input", (e) => {
      state.calcLiters = Number(e.target.value);
      renderCalc();
    });

    $("#refreshBtn").addEventListener("click", refreshSelected);
  }

  /* ---------- init ---------- */
  function init() {
    if (!window.OIL_SNAPSHOT || !window.OIL_SNAPSHOT.provinces) {
      $("#ticketProvince").textContent = "数据未载入";
      $("#ticketPrice").textContent = "—";
      $("#headDate").textContent = "数据载入失败";
      toast("未找到油价数据，请确认 data/data.js 是否存在");
      return;
    }

    SNAPSHOT = window.OIL_SNAPSHOT;
    if (window.OIL_STANDALONE) {
      const refreshBtn = $("#refreshBtn");
      if (refreshBtn) refreshBtn.style.display = "none";
    }
    Object.keys(SNAPSHOT.provinces).forEach((name) => {
      const p = SNAPSHOT.provinces[name];
      if (!p.zones || !p.zones.length) {
        SNAPSHOT.provinces[name] = normalizeProvince({ date: p.date, data: p.data || {} });
      }
    });

    mergeCache();
    loadPref();

    if (!SNAPSHOT.provinces[state.province]) {
      state.province = provinces()[0];
    }
    state.calcProvince = state.province;

    buildMap();
    bindEvents();
    renderAll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
