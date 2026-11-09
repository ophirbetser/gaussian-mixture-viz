"use strict";

// ---------- config ----------
const MAX_N = 5;
const SAMPLES = 400;
const DEFAULTS = [
  { w: 1, mu: -2, s: 1 },
  { w: 1, mu: 2.5, s: 1.2 },
  { w: 0.6, mu: 6, s: 0.8 },
  { w: 0.8, mu: -6, s: 0.7 },
  { w: 0.5, mu: 0, s: 3 },
];
const PARAMS = [
  { key: "w", label: "w", name: "Weight", min: 0, max: 10, step: 0.1 },
  { key: "mu", label: "μ", name: "Mean", min: -10, max: 10, step: 0.1 },
  { key: "s", label: "σ", name: "Std dev", min: 0.1, max: 5, step: 0.05 },
];
const MARGIN = { l: 44, r: 12, t: 10, b: 28 };

// ---------- state ----------
let state = { n: 2, comps: DEFAULTS.map((c) => ({ ...c })) };
let locked = null;   // { xmin, xmax, ymax } when "Lock axes" is on
let view = null;     // last computed view, used for hover + locking
let hoverX = null;

// ---------- math ----------
const SQRT2PI = Math.sqrt(2 * Math.PI);

// Abramowitz & Stegun 7.1.26 (max error ~1.5e-7)
function erf(x) {
  const sign = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
}
function normPdf(x, mu, s) {
  const z = (x - mu) / s;
  return Math.exp(-0.5 * z * z) / (s * SQRT2PI);
}
function normCdf(x, mu, s) {
  return 0.5 * (1 + erf((x - mu) / (s * Math.SQRT2)));
}

// Active components with normalized weights p (sum to 1).
function activeComps() {
  const cs = state.comps.slice(0, state.n);
  const total = cs.reduce((a, c) => a + c.w, 0);
  return cs.map((c, i) => ({ ...c, i, p: total > 0 ? c.w / total : 1 / cs.length }));
}
function mixPdf(x, cs) { return cs.reduce((a, c) => a + c.p * normPdf(x, c.mu, c.s), 0); }
function mixCdf(x, cs) { return cs.reduce((a, c) => a + c.p * normCdf(x, c.mu, c.s), 0); }

function mixStats(cs) {
  const mean = cs.reduce((a, c) => a + c.p * c.mu, 0);
  const second = cs.reduce((a, c) => a + c.p * (c.s * c.s + c.mu * c.mu), 0);
  const sd = Math.sqrt(Math.max(0, second - mean * mean));
  let lo = Math.min(...cs.map((c) => c.mu - 10 * c.s));
  let hi = Math.max(...cs.map((c) => c.mu + 10 * c.s));
  for (let k = 0; k < 80; k++) {
    const mid = (lo + hi) / 2;
    if (mixCdf(mid, cs) < 0.5) lo = mid; else hi = mid;
  }
  return { mean, sd, median: (lo + hi) / 2 };
}

function countPeaks(ys) {
  const max = Math.max(...ys);
  let peaks = 0;
  for (let i = 1; i < ys.length - 1; i++) {
    if (ys[i] > ys[i - 1] && ys[i] >= ys[i + 1] && ys[i] > max * 1e-3) peaks++;
  }
  return Math.max(peaks, 1);
}

// ---------- formatting ----------
function fmt(v, digits = 3) {
  if (!isFinite(v)) return "–";
  if (Math.abs(v) < 1e-12) return "0";
  const s = Math.abs(v) >= 1000 || Math.abs(v) < 0.001 ? v.toExponential(2) : Number(v.toPrecision(digits)).toString();
  return s.replace("-", "−");
}
function niceTicks(min, max, count) {
  const step0 = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const r = step0 / mag;
  const step = (r >= 7.5 ? 10 : r >= 3.5 ? 5 : r >= 1.5 ? 2 : 1) * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + 1e-9; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const els = {
  cards: $("cards"),
  nSelect: $("n-select"),
  lock: $("lock-axes"),
  stats: $("stats"),
  legend: $("legend"),
  pdf: $("pdf-chart"),
  cdf: $("cdf-chart"),
  table: $("data-table"),
};
const seriesVar = (i) => `var(--series-${i + 1})`;

function buildCards() {
  els.cards.innerHTML = "";
  state.comps.forEach((c, i) => {
    const card = document.createElement("article");
    card.className = "card";
    card.style.setProperty("--c", seriesVar(i));
    card.dataset.i = i;
    card.innerHTML = `
      <div class="card-head">
        <span class="swatch" aria-hidden="true"></span>
        <span class="card-title">Component ${i + 1}</span>
        <span class="card-share" data-share></span>
      </div>
      ${PARAMS.map((p) => `
        <div class="param">
          <label for="r-${p.key}-${i}" title="${p.name}">${p.label}</label>
          <input type="range" id="r-${p.key}-${i}" data-key="${p.key}" min="${p.min}" max="${p.max}" step="${p.step}" aria-label="${p.name}, component ${i + 1}">
          <input type="number" data-key="${p.key}" min="${p.min}" max="${p.max}" step="${p.step}" aria-label="${p.name}, component ${i + 1}">
        </div>`).join("")}`;
    els.cards.appendChild(card);

    card.addEventListener("input", (e) => {
      const key = e.target.dataset.key;
      if (!key) return;
      const p = PARAMS.find((q) => q.key === key);
      let v = parseFloat(e.target.value);
      if (!isFinite(v)) return;
      v = Math.min(p.max, Math.max(p.min, v));
      state.comps[i][key] = v;
      // keep the paired control in sync
      for (const inp of card.querySelectorAll(`input[data-key="${key}"]`)) {
        if (inp !== e.target) inp.value = v;
      }
      update();
    });
    // normalize out-of-range typing when leaving the number box
    card.addEventListener("change", (e) => {
      if (e.target.type === "number") e.target.value = state.comps[i][e.target.dataset.key];
    });
  });
}

function syncControls() {
  for (const card of els.cards.children) {
    const i = Number(card.dataset.i);
    card.hidden = i >= state.n;
    for (const inp of card.querySelectorAll("input[data-key]")) inp.value = state.comps[i][inp.dataset.key];
  }
  for (const b of els.nSelect.querySelectorAll("button")) {
    b.setAttribute("aria-checked", String(Number(b.dataset.n) === state.n));
  }
}

// ---------- charts ----------
function computeView(cs) {
  let xmin = Math.min(...cs.map((c) => c.mu - 4 * c.s));
  let xmax = Math.max(...cs.map((c) => c.mu + 4 * c.s));
  if (locked) ({ xmin, xmax } = locked);
  const xs = Array.from({ length: SAMPLES + 1 }, (_, k) => xmin + (k / SAMPLES) * (xmax - xmin));
  const pdf = xs.map((x) => mixPdf(x, cs));
  const cdf = xs.map((x) => mixCdf(x, cs));
  const comps = cs.map((c) => xs.map((x) => c.p * normPdf(x, c.mu, c.s)));
  const ymax = locked ? locked.ymax : Math.max(...pdf) * 1.12;
  return { cs, xs, pdf, cdf, comps, xmin, xmax, ymax };
}

function makeScales(el, height, xmin, xmax, ymax) {
  const width = Math.max(260, el.clientWidth);
  const iw = width - MARGIN.l - MARGIN.r;
  const ih = height - MARGIN.t - MARGIN.b;
  return {
    width, height, iw, ih,
    x: (v) => MARGIN.l + ((v - xmin) / (xmax - xmin)) * iw,
    y: (v) => MARGIN.t + ih - (v / ymax) * ih,
    invX: (px) => xmin + ((px - MARGIN.l) / iw) * (xmax - xmin),
  };
}

function pathD(xs, ys, sc) {
  let d = "";
  for (let k = 0; k < xs.length; k++) d += `${k ? "L" : "M"}${sc.x(xs[k]).toFixed(1)},${sc.y(ys[k]).toFixed(1)}`;
  return d;
}

function axesSvg(sc, xmin, xmax, yTicks, yFmt) {
  let s = "";
  for (const t of yTicks) {
    const y = sc.y(t).toFixed(1);
    s += `<line class="${t === 0 ? "baseline" : "gridline"}" x1="${MARGIN.l}" x2="${MARGIN.l + sc.iw}" y1="${y}" y2="${y}"/>`;
    s += `<text x="${MARGIN.l - 6}" y="${y}" text-anchor="end" dominant-baseline="middle">${yFmt(t)}</text>`;
  }
  for (const t of niceTicks(xmin, xmax, Math.max(3, Math.floor(sc.iw / 70)))) {
    s += `<text x="${sc.x(t).toFixed(1)}" y="${MARGIN.t + sc.ih + 18}" text-anchor="middle">${fmt(t)}</text>`;
  }
  return s;
}

function drawPdf(v) {
  const height = window.innerWidth < 560 ? 240 : 300;
  const sc = makeScales(els.pdf, height, v.xmin, v.xmax, v.ymax);
  const base = sc.y(0).toFixed(1);
  const line = pathD(v.xs, v.pdf, sc);
  const area = `${line}L${sc.x(v.xmax).toFixed(1)},${base}L${sc.x(v.xmin).toFixed(1)},${base}Z`;
  const yTicks = niceTicks(0, v.ymax, 4);
  let s = `<svg viewBox="0 0 ${sc.width} ${height}" height="${height}" role="img" aria-label="Mixture probability density with ${v.cs.length} components">`;
  s += `<defs><clipPath id="clip-pdf"><rect x="${MARGIN.l}" y="${MARGIN.t}" width="${sc.iw}" height="${sc.ih}"/></clipPath></defs>`;
  s += axesSvg(sc, v.xmin, v.xmax, yTicks, (t) => fmt(t, 2));
  s += `<g clip-path="url(#clip-pdf)">`;
  s += `<path class="mix-area" d="${area}"/>`;
  v.comps.forEach((ys, k) => { s += `<path class="comp-line" style="--c:${seriesVar(v.cs[k].i)}" d="${pathD(v.xs, ys, sc)}"/>`; });
  s += `<path class="mix-line" d="${line}"/>`;
  s += `</g><g class="hover-layer"></g>`;
  s += `<rect class="hit" x="${MARGIN.l}" y="0" width="${sc.iw}" height="${height}" fill="transparent"/></svg>`;
  s += `<div class="tooltip" hidden></div>`;
  els.pdf.innerHTML = s;
  els.pdf.sc = sc;
}

function drawCdf(v) {
  const height = window.innerWidth < 560 ? 180 : 210;
  const sc = makeScales(els.cdf, height, v.xmin, v.xmax, 1.04);
  let s = `<svg viewBox="0 0 ${sc.width} ${height}" height="${height}" role="img" aria-label="Mixture cumulative distribution">`;
  s += axesSvg(sc, v.xmin, v.xmax, [0, 0.25, 0.5, 0.75, 1], (t) => String(t));
  s += `<path class="mix-line" d="${pathD(v.xs, v.cdf, sc)}"/>`;
  s += `<g class="hover-layer"></g>`;
  s += `<rect class="hit" x="${MARGIN.l}" y="0" width="${sc.iw}" height="${height}" fill="transparent"/></svg>`;
  s += `<div class="tooltip" hidden></div>`;
  els.cdf.innerHTML = s;
  els.cdf.sc = sc;
}

function drawHover() {
  for (const el of [els.pdf, els.cdf]) {
    const layer = el.querySelector(".hover-layer");
    const tip = el.querySelector(".tooltip");
    if (!layer) continue;
    if (hoverX === null || !view) { layer.innerHTML = ""; tip.hidden = true; continue; }
    const sc = el.sc;
    const x = hoverX;
    const px = sc.x(x).toFixed(1);
    const isPdf = el === els.pdf;
    let s = `<line class="crosshair" x1="${px}" x2="${px}" y1="${MARGIN.t}" y2="${MARGIN.t + sc.ih}"/>`;
    if (isPdf) {
      for (const c of view.cs) {
        const y = c.p * normPdf(x, c.mu, c.s);
        if (y / view.ymax > 0.01) s += `<circle class="hover-dot comp" style="--c:${seriesVar(c.i)}" cx="${px}" cy="${sc.y(y).toFixed(1)}" r="4"/>`;
      }
      s += `<circle class="hover-dot" cx="${px}" cy="${sc.y(mixPdf(x, view.cs)).toFixed(1)}" r="5"/>`;
    } else {
      s += `<circle class="hover-dot" cx="${px}" cy="${sc.y(mixCdf(x, view.cs)).toFixed(1)}" r="5"/>`;
    }
    layer.innerHTML = s;

    let html = `<div class="tt-head">x = ${fmt(x)}</div>`;
    html += `<div class="tt-row">f(x)<b>${fmt(mixPdf(x, view.cs))}</b></div>`;
    html += `<div class="tt-row">F(x)<b>${fmt(mixCdf(x, view.cs))}</b></div>`;
    if (isPdf) {
      for (const c of view.cs) {
        html += `<div class="tt-row"><span class="swatch" style="--c:${seriesVar(c.i)}"></span>Comp ${c.i + 1}<b>${fmt(c.p * normPdf(x, c.mu, c.s))}</b></div>`;
      }
    }
    tip.innerHTML = html;
    tip.hidden = false;
    // place the tooltip on the side away from the cursor
    const tipW = tip.offsetWidth;
    const left = sc.x(x) + 14 + tipW > sc.width ? sc.x(x) - 14 - tipW : sc.x(x) + 14;
    tip.style.left = `${Math.max(0, left)}px`;
  }
}

function attachHover(el) {
  const move = (e) => {
    if (!el.sc || !view) return;
    const rect = el.querySelector("svg").getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * el.sc.width;
    if (px < MARGIN.l || px > MARGIN.l + el.sc.iw) { hoverX = null; drawHover(); return; }
    hoverX = el.sc.invX(px);
    drawHover();
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerdown", move);
  el.addEventListener("pointerleave", () => { hoverX = null; drawHover(); });
}

// ---------- side panels ----------
function renderStats(v) {
  const st = mixStats(v.cs);
  const peaks = countPeaks(v.pdf);
  const items = [
    ["Mean", fmt(st.mean)],
    ["Std dev", fmt(st.sd)],
    ["Median", fmt(st.median)],
    ["Peaks", String(peaks)],
  ];
  els.stats.innerHTML = items.map(([k, val]) => `<div class="stat"><div class="stat-label">${k}</div><div class="stat-value">${val}</div></div>`).join("");
}

function renderLegend(v) {
  let s = `<span class="legend-item"><span class="legend-line mix" style="--c:var(--text-primary)"></span>Mixture</span>`;
  for (const c of v.cs) s += `<span class="legend-item"><span class="legend-line dashed" style="--c:${seriesVar(c.i)}"></span>${c.i + 1}</span>`;
  els.legend.innerHTML = s;
}

function renderShares(v) {
  for (const card of els.cards.children) {
    const c = v.cs.find((q) => q.i === Number(card.dataset.i));
    card.querySelector("[data-share]").textContent = c ? `${(c.p * 100).toFixed(1)}% of mass` : "";
  }
}

function renderTable(v) {
  const rows = 25;
  let h = `<thead><tr><th>x</th><th>f(x)</th><th>F(x)</th>${v.cs.map((c) => `<th>w·N<sub>${c.i + 1}</sub></th>`).join("")}</tr></thead><tbody>`;
  for (let k = 0; k <= rows; k++) {
    const x = v.xmin + (k / rows) * (v.xmax - v.xmin);
    h += `<tr><td>${fmt(x)}</td><td>${fmt(mixPdf(x, v.cs))}</td><td>${fmt(mixCdf(x, v.cs))}</td>${v.cs.map((c) => `<td>${fmt(c.p * normPdf(x, c.mu, c.s))}</td>`).join("")}</tr>`;
  }
  els.table.innerHTML = h + "</tbody>";
}

// ---------- URL hash ----------
function writeHash() {
  const c = state.comps.map((q) => [q.w, q.mu, q.s].map((n) => +n.toFixed(3)).join(",")).join(";");
  history.replaceState(null, "", `#n=${state.n}&c=${c}`);
}
function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const n = Number(params.get("n"));
  if (n >= 2 && n <= MAX_N) state.n = n;
  const c = params.get("c");
  if (!c) return;
  c.split(";").slice(0, MAX_N).forEach((part, i) => {
    const vals = part.split(",").map(Number);
    PARAMS.forEach((p, k) => {
      if (isFinite(vals[k])) state.comps[i][p.key] = Math.min(p.max, Math.max(p.min, vals[k]));
    });
  });
}

// ---------- main ----------
function update() {
  const cs = activeComps();
  view = computeView(cs);
  drawPdf(view);
  drawCdf(view);
  drawHover();
  renderStats(view);
  renderLegend(view);
  renderShares(view);
  if (els.table.closest("details").open) renderTable(view);
  writeHash();
}

els.nSelect.addEventListener("click", (e) => {
  const n = Number(e.target.dataset.n);
  if (!n) return;
  state.n = n;
  syncControls();
  update();
});

els.lock.addEventListener("change", () => {
  locked = els.lock.checked && view ? { xmin: view.xmin, xmax: view.xmax, ymax: view.ymax } : null;
  update();
});

$("randomize").addEventListener("click", () => {
  const r = (a, b, step) => Math.round((a + Math.random() * (b - a)) / step) * step;
  for (let i = 0; i < state.n; i++) {
    state.comps[i] = { w: +r(0.5, 3, 0.1).toFixed(1), mu: +r(-6, 6, 0.1).toFixed(1), s: +r(0.4, 2.2, 0.05).toFixed(2) };
  }
  syncControls();
  update();
});

$("reset").addEventListener("click", () => {
  state = { n: 2, comps: DEFAULTS.map((c) => ({ ...c })) };
  locked = null;
  els.lock.checked = false;
  syncControls();
  update();
});

els.table.closest("details").addEventListener("toggle", (e) => { if (e.target.open && view) renderTable(view); });

attachHover(els.pdf);
attachHover(els.cdf);

let resizeFrame = 0;
new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => { if (view) { drawPdf(view); drawCdf(view); drawHover(); } });
}).observe(els.pdf);

readHash();
buildCards();
syncControls();
update();
