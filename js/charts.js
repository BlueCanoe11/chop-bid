// Small dependency-free SVG line chart with a crosshair tooltip.
const NS = 'http://www.w3.org/2000/svg';
const tip = () => document.getElementById('tooltip');

function el(name, attrs = {}, parent) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || step0;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

// data: [{x, y}], opts: { cls, yFmt, xFmt, yMin, yMax, marker: {x, label}, tipFn(d) }
export function lineChart(container, data, opts) {
  container.innerHTML = '';
  const W = 520, H = 150, m = { l: 40, r: 12, t: 12, b: 22 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': opts.label || 'chart' }, container);
  if (!data.length) return;
  const xs = data.map((d) => d.x), ys = data.map((d) => d.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = opts.yMin ?? Math.min(0, ...ys), y1 = opts.yMax ?? Math.max(...ys);
  if (y1 - y0 < 1e-9) y1 = y0 + 1;
  const X = (v) => m.l + ((v - x0) / (x1 - x0 || 1)) * (W - m.l - m.r);
  const Y = (v) => H - m.b - ((v - y0) / (y1 - y0)) * (H - m.t - m.b);

  for (const t of niceTicks(y0, y1)) {
    el('line', { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), class: 'grid-line' }, svg);
    el('text', { x: m.l - 6, y: Y(t) + 3, 'text-anchor': 'end', class: 'axis-text' }, svg).textContent = opts.yFmt(t);
  }
  for (const t of niceTicks(x0, x1, 5)) {
    el('text', { x: X(t), y: H - 6, 'text-anchor': 'middle', class: 'axis-text' }, svg).textContent = opts.xFmt(t);
  }
  el('path', { d: data.map((d, i) => `${i ? 'L' : 'M'}${X(d.x).toFixed(1)},${Y(d.y).toFixed(1)}`).join(''), class: opts.cls }, svg);

  if (opts.marker) {
    const d = data.reduce((best, p) => (Math.abs(p.x - opts.marker.x) < Math.abs(best.x - opts.marker.x) ? p : best), data[0]);
    el('line', { x1: X(d.x), x2: X(d.x), y1: m.t, y2: H - m.b, class: 'ref' }, svg);
    el('circle', { cx: X(d.x), cy: Y(d.y), r: 5, class: 'marker', fill: `var(--${opts.cls === 'line-2' ? 'series-2' : 'series-1'})` }, svg);
    const tx = X(d.x) > W - 90 ? X(d.x) - 6 : X(d.x) + 6;
    el('text', { x: tx, y: m.t + 8, 'text-anchor': X(d.x) > W - 90 ? 'end' : 'start', class: 'ref-text' }, svg).textContent = opts.marker.label;
  }

  const cross = el('line', { y1: m.t, y2: H - m.b, class: 'cross', visibility: 'hidden' }, svg);
  const dot = el('circle', { r: 4, class: 'marker', fill: `var(--${opts.cls === 'line-2' ? 'series-2' : 'series-1'})`, visibility: 'hidden' }, svg);
  const hit = el('rect', { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: 'transparent' }, svg);
  hit.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * W;
    const xv = x0 + ((vx - m.l) / (W - m.l - m.r)) * (x1 - x0);
    const d = data.reduce((best, p) => (Math.abs(p.x - xv) < Math.abs(best.x - xv) ? p : best), data[0]);
    cross.setAttribute('x1', X(d.x)); cross.setAttribute('x2', X(d.x)); cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', X(d.x)); dot.setAttribute('cy', Y(d.y)); dot.setAttribute('visibility', 'visible');
    const t = tip();
    t.innerHTML = opts.tipFn(d);
    t.hidden = false;
    t.style.left = `${Math.min(window.innerWidth - 180, e.clientX + 12)}px`;
    t.style.top = `${e.clientY - 36}px`;
  });
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip().hidden = true;
  });
}

// Several series on one shared y-axis (same units), with a legend and labels at the
// line ends. series: [{ name, color (CSS color/var), dash?, points: [{x, y}] }]
// opts: { yFmt, xFmt, yMin, yMax, height, label, xTicks?, tipFn(x, rows) }
export function multiLineChart(container, series, opts) {
  container.innerHTML = '';
  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML = series.map((s) => `<span><i style="background:${s.color}${s.dash ? ';opacity:.7' : ''}"></i>${s.name}</span>`).join('');
  container.appendChild(legend);
  const W = 560, H = opts.height || 190, m = { l: 44, r: opts.endLabels === false ? 14 : 96, t: 10, b: 24 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': opts.label || 'chart' }, container);
  const all = series.flatMap((s) => s.points);
  if (!all.length) return;
  const x0 = Math.min(...all.map((p) => p.x)), x1 = Math.max(...all.map((p) => p.x));
  let y0 = opts.yMin ?? Math.min(0, ...all.map((p) => p.y)), y1 = opts.yMax ?? Math.max(...all.map((p) => p.y));
  if (y1 - y0 < 1e-9) y1 = y0 + 1;
  const X = (v) => m.l + ((v - x0) / (x1 - x0 || 1)) * (W - m.l - m.r);
  const Y = (v) => H - m.b - ((v - y0) / (y1 - y0)) * (H - m.t - m.b);
  for (const t of niceTicks(y0, y1)) {
    el('line', { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), class: 'grid-line' }, svg);
    el('text', { x: m.l - 6, y: Y(t) + 3, 'text-anchor': 'end', class: 'axis-text' }, svg).textContent = opts.yFmt(t);
  }
  for (const t of opts.xTicks || niceTicks(x0, x1, 6)) {
    el('text', { x: X(t), y: H - 6, 'text-anchor': 'middle', class: 'axis-text' }, svg).textContent = opts.xFmt(t);
  }
  // End labels, nudged apart so they never overlap.
  const ends = series.map((s) => ({ s, y: Y(s.points[s.points.length - 1].y) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 12) ends[i].y = ends[i - 1].y + 12;
  for (const s of series) {
    el('path', {
      d: s.points.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(''),
      fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', ...(s.dash ? { 'stroke-dasharray': '5 4' } : {}),
    }, svg);
  }
  for (const e of opts.endLabels === false ? [] : ends) {
    const last = e.s.points[e.s.points.length - 1];
    el('text', { x: X(last.x) + 6, y: e.y + 3, class: 'end-label' }, svg).textContent = `${e.s.short || e.s.name} ${opts.yFmt(last.y)}`;
  }
  const cross = el('line', { y1: m.t, y2: H - m.b, class: 'cross', visibility: 'hidden' }, svg);
  const dots = series.map((s) => el('circle', { r: 3.5, fill: s.color, class: 'marker', visibility: 'hidden' }, svg));
  const hit = el('rect', { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: 'transparent' }, svg);
  const xs = [...new Set(all.map((p) => p.x))].sort((a, b) => a - b);
  hit.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const xv = x0 + ((((e.clientX - r.left) / r.width) * W - m.l) / (W - m.l - m.r)) * (x1 - x0);
    const x = xs.reduce((b, v) => (Math.abs(v - xv) < Math.abs(b - xv) ? v : b), xs[0]);
    cross.setAttribute('x1', X(x)); cross.setAttribute('x2', X(x)); cross.setAttribute('visibility', 'visible');
    const rows = series.map((s, i) => {
      const p = s.points.find((q) => q.x === x);
      if (p) { dots[i].setAttribute('cx', X(x)); dots[i].setAttribute('cy', Y(p.y)); dots[i].setAttribute('visibility', 'visible'); } else dots[i].setAttribute('visibility', 'hidden');
      return { name: s.name, y: p ? p.y : null };
    });
    const t = tip();
    t.innerHTML = opts.tipFn(x, rows);
    t.hidden = false;
    t.style.left = `${Math.min(window.innerWidth - 220, e.clientX + 12)}px`;
    t.style.top = `${e.clientY - 40}px`;
  });
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); tip().hidden = true;
  });
}
