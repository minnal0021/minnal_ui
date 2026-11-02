// ── Probe trace sub-tab ──────────────────────────────────────────────────────
// One query's walk through a store's IVF partition: the postings Pass 1 probes,
// nearest first, each with its document count and its lowest and highest
// Pass-1 score (GET /admin/indices/{ns}/vector/probe-trace).
//
// Drawn with d3 as a force-directed graph: the query in the middle and one node
// per probed posting, linked to the query at a length set by its distance. The
// layout is computed once per trace, off screen; stepping through the probes
// only shows or hides nodes, so a trace of a thousand postings stays responsive.

const ptrace = {
  ns: null,
  query: '',
  nProbes: null,
  data: null,       // the endpoint's response
  layout: null,     // { nodes, links } with fixed positions, built once per trace
  rank: 0,          // probes shown: ranks 0..rank
  selected: null,   // posting rank shown in the side panel (null: the current probe)
  timer: null,
  loading: false,
  error: null,
};

const PT_MAX_PROBES = 1024;

function resetProbeTrace(ns) {
  stopProbeTracePlay();
  Object.assign(ptrace, { ns, data: null, layout: null, rank: 0, selected: null, error: null });
}

function renderVopsTrace() {
  if (ptrace.ns !== vops.ns) resetProbeTrace(vops.ns);
  const postings = vops.partition?.postings ?? null;
  const dflt = ptrace.nProbes ?? Math.min(effectiveProbes(vopsSettings(), postings ?? Infinity) ?? 64, PT_MAX_PROBES);
  const d = ptrace.data;
  const n = d?.postings?.length ?? 0;
  return `
    <div class="section">
      <div class="section-header"><span class="section-title"
        title="Embeds the query as a search does, then scores every document in the probed postings with the store's Pass-1 codes. Ranks nothing.">PROBE TRACE</span></div>
      <form class="pt-form" onsubmit="event.preventDefault(); runProbeTrace()">
        <input id="pt-query" class="pt-query" type="text" placeholder="Query text" value="${esc(ptrace.query)}" required>
        <label class="pt-label" title="Postings to probe, nearest first (1–${PT_MAX_PROBES}). The store probes ${postings == null ? 'its max_probes' : `${effectiveProbes(vopsSettings(), postings)} of ${postings}`} on a search.">
          Probes <input id="pt-probes" type="number" min="1" max="${PT_MAX_PROBES}" value="${dflt}">
        </label>
        <button class="btn btn-accent" type="submit" ${ptrace.loading ? 'disabled' : ''}>${ptrace.loading ? 'Tracing…' : 'Trace'}</button>
      </form>
      ${ptrace.error ? `<div class="alert alert-error">${esc(ptrace.error)}</div>` : ''}
    </div>
    ${d ? `
    <div class="section">
      <div class="pt-controls">
        <button class="btn btn-secondary btn-sm" id="pt-play" onclick="toggleProbeTracePlay()">${ptrace.timer ? '❚❚ Pause' : '▶ Play'}</button>
        <input id="pt-rank" class="pt-rank" type="range" min="1" max="${n}" value="${Math.min(ptrace.rank + 1, n)}"
               oninput="setProbeTraceRank(this.valueAsNumber - 1)" ${n ? '' : 'disabled'}>
        <span class="pt-rank-label" id="pt-rank-label"></span>
      </div>
      <div class="pt-layout">
        <div class="pt-graph-wrap">
          <svg id="pt-graph" class="pt-graph" role="img" aria-label="Probed postings around the query"></svg>
          <div class="pt-legend" id="pt-legend"></div>
          <div class="pt-tip" id="pt-tip" hidden></div>
        </div>
        <div class="admin-card pt-panel" id="pt-panel"></div>
      </div>
      <div class="pt-chart-title" title="Each probe's lowest and highest Pass-1 document score. The highest falls as probes reach postings farther from the query: they add less and less to Pass 1's candidates.">
        Pass-1 score range by probe</div>
      <svg id="pt-chart" class="pt-chart" role="img" aria-label="Lowest and highest Pass-1 score per probe"></svg>
    </div>` : ''}`;
}

async function runProbeTrace() {
  const query = document.getElementById('pt-query')?.value.trim();
  const nProbes = document.getElementById('pt-probes')?.valueAsNumber;
  if (!query) return;
  if (!(nProbes >= 1 && nProbes <= PT_MAX_PROBES)) {
    ptrace.error = `Probes must be between 1 and ${PT_MAX_PROBES}.`;
    renderVopsBody();
    return;
  }
  stopProbeTracePlay();
  Object.assign(ptrace, { query, nProbes, loading: true, error: null });
  renderVopsBody();
  const ns = ptrace.ns;
  try {
    const data = await Api.vectorProbeTrace(ns, query, nProbes);
    if (ns !== ptrace.ns) return;
    Object.assign(ptrace, { data, layout: buildProbeTraceLayout(data), rank: 0, selected: null });
  } catch (e) {
    ptrace.error = e.message;
  } finally {
    ptrace.loading = false;
  }
  renderVopsBody();
  if (ptrace.data?.postings?.length) toggleProbeTracePlay();
}

// ── Layout (once per trace) ──────────────────────────────────────────────────
const PT_W = 720, PT_H = 520;

function buildProbeTraceLayout(data) {
  const ps = data.postings ?? [];
  const dists = ps.map(p => p.distance).filter(x => x != null);
  // Distances of a query to its postings sit in a narrow band (0.8–1.2 is
  // typical), so the band, not zero, is stretched over the link lengths.
  const dist = d3.scaleLinear().domain(d3.extent(dists.length ? dists : [0, 1])).range([70, Math.min(PT_W, PT_H) / 2 - 20]);
  const docs = d3.scaleSqrt().domain([0, d3.max(ps, p => p.documents) || 1]).range([3, ps.length > 300 ? 10 : 16]);
  const nodes = [{ id: 'q', query: true, x: 0, y: 0, fx: 0, fy: 0, r: 9 }];
  const links = [];
  ps.forEach((p, i) => {
    // Seed on a spiral by rank so the simulation settles fast and near probes start near the middle.
    const a = i * 2.39996, rr = dist(p.distance ?? dists[0] ?? 0);
    nodes.push({ id: p.posting_id, p, x: rr * Math.cos(a), y: rr * Math.sin(a), r: docs(p.documents) });
    links.push({ source: 'q', target: p.posting_id, len: rr, rank: p.rank });
  });
  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(l => l.len).strength(0.9))
    .force('charge', d3.forceManyBody().strength(ps.length > 300 ? -6 : -20).distanceMax(120))
    .force('collide', d3.forceCollide(d => d.r + 1.5).iterations(2))
    .stop();
  const ticks = ps.length > 500 ? 70 : ps.length > 300 ? 120 : 220;
  for (let i = 0; i < ticks; i++) sim.tick();
  return { nodes, links, posting: nodes.slice(1), dist };
}

// ── Drawing ──────────────────────────────────────────────────────────────────
function drawProbeTrace() {
  const d = ptrace.data, L = ptrace.layout;
  const svgEl = document.getElementById('pt-graph');
  if (!d || !L || !svgEl) return;
  const ps = d.postings;
  const maxes = ps.map(p => p.max?.dot_product).filter(x => x != null);
  const color = d3.scaleSequential(d3.interpolatePlasma).domain(d3.extent(maxes.length ? maxes : [0, 1]));
  ptrace.color = color;

  // Fit the view to the laid-out nodes (a large trace spreads past the base size).
  const pad = 24;
  const ext = (k) => [d3.min(L.nodes, n => n[k] - (n.r ?? 0)), d3.max(L.nodes, n => n[k] + (n.r ?? 0))];
  const [x0, x1] = ext('x'), [y0, y1] = ext('y');
  const half = Math.max(PT_W / 2, Math.abs(x0), Math.abs(x1), (Math.max(Math.abs(y0), Math.abs(y1))) * PT_W / PT_H) + pad;
  const svg = d3.select(svgEl).attr('viewBox', [-half, -half * PT_H / PT_W, 2 * half, 2 * half * PT_H / PT_W]);
  svg.selectAll('*').remove();
  const g = svg.append('g');
  // Drag pans; Ctrl/⌘ + scroll zooms (a plain scroll scrolls the page); double-click resets.
  const zoom = d3.zoom().scaleExtent([0.3, 8])
    .filter(e => (e.type === 'wheel' ? e.ctrlKey || e.metaKey : !e.button && e.type !== 'dblclick'))
    .on('zoom', e => g.attr('transform', e.transform));
  svg.call(zoom).on('dblclick.reset', () => svg.transition().duration(300).call(zoom.transform, d3.zoomIdentity));

  // Distance rings: what a link length means.
  const [d0, d1] = L.dist.domain();
  const rings = d0 === d1 ? [d0] : d3.ticks(d0, d1, 4).filter(t => t >= d0 && t <= d1);
  const ringG = g.append('g').attr('class', 'pt-rings');
  ringG.selectAll('circle').data(rings).join('circle').attr('r', t => L.dist(t));
  ringG.selectAll('text').data(rings).join('text').attr('x', 3).attr('y', t => -L.dist(t) - 3).text(t => `d ${t.toFixed(2)}`);

  g.append('g').attr('class', 'pt-links').selectAll('line').data(L.links).join('line')
    .attr('x1', l => l.source.x).attr('y1', l => l.source.y).attr('x2', l => l.target.x).attr('y2', l => l.target.y);

  const tip = document.getElementById('pt-tip');
  g.append('g').attr('class', 'pt-nodes').selectAll('circle').data(L.posting).join('circle')
    .attr('cx', n => n.x).attr('cy', n => n.y).attr('r', n => n.r)
    .attr('fill', n => (n.p.max ? color(n.p.max.dot_product) : 'transparent'))
    .classed('pt-empty', n => !n.p.documents)
    .on('mouseenter', (e, n) => {
      tip.hidden = false;
      tip.innerHTML = `<b>Posting ${n.p.posting_id}</b> · probe ${n.p.rank + 1}<br>
        ${fmt(n.p.documents)} documents · distance ${num3(n.p.distance)}<br>
        max ${num3(n.p.max?.dot_product)} · min ${num3(n.p.min?.dot_product)}`;
    })
    .on('mousemove', e => {
      const box = svgEl.parentElement.getBoundingClientRect();
      tip.style.left = `${e.clientX - box.left + 12}px`;
      tip.style.top = `${e.clientY - box.top + 12}px`;
    })
    .on('mouseleave', () => { tip.hidden = true; })
    .on('click', (e, n) => { ptrace.selected = n.p.rank; updateProbeTrace(); });

  g.append('circle').attr('class', 'pt-query-node').attr('r', 9);
  g.append('text').attr('class', 'pt-query-label').attr('y', -14).attr('text-anchor', 'middle').text('query');
  g.append('circle').attr('class', 'pt-cursor').attr('r', 0);

  document.getElementById('pt-legend').innerHTML = `
    <span>fill: highest score in the posting</span>
    <span class="pt-ramp" style="background:linear-gradient(90deg,${d3.range(0, 1.01, 0.25).map(t => d3.interpolatePlasma(t)).join(',')})"></span>
    <span>${num3(color.domain()[0])} – ${num3(color.domain()[1])}</span>
    <span class="text-muted">· size: documents · link length: distance from the query · drag to pan, Ctrl/⌘ + scroll to zoom, double-click to reset</span>`;

  drawProbeTraceChart();
  updateProbeTrace();
}

function drawProbeTraceChart() {
  const svgEl = document.getElementById('pt-chart');
  const ps = ptrace.data?.postings ?? [];
  if (!svgEl || !ps.length) return;
  const W = 980, H = 200, m = { t: 10, r: 16, b: 30, l: 48 };
  const svg = d3.select(svgEl).attr('viewBox', [0, 0, W, H]);
  svg.selectAll('*').remove();
  const scored = ps.filter(p => p.max);
  const x = d3.scaleLinear().domain([1, Math.max(ps.length, 2)]).range([m.l, W - m.r]);
  const y = d3.scaleLinear()
    .domain([Math.min(0, d3.min(scored, p => p.min.dot_product) ?? 0), d3.max(scored, p => p.max.dot_product) ?? 1]).nice()
    .range([H - m.b, m.t]);
  svg.append('g').attr('class', 'pt-axis').attr('transform', `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).ticks(Math.min(ps.length, 10)).tickFormat(d3.format('d')));
  svg.append('g').attr('class', 'pt-axis').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5));
  svg.append('text').attr('class', 'pt-axis-label').attr('x', W - m.r).attr('y', H - 2).attr('text-anchor', 'end').text('probe (nearest first)');
  svg.append('line').attr('class', 'pt-zero').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(0)).attr('y2', y(0));
  svg.append('path').attr('class', 'pt-band').datum(scored)
    .attr('d', d3.area().x(p => x(p.rank + 1)).y0(p => y(p.min.dot_product)).y1(p => y(p.max.dot_product)));
  svg.append('path').attr('class', 'pt-max-line').datum(scored)
    .attr('d', d3.line().x(p => x(p.rank + 1)).y(p => y(p.max.dot_product)));
  svg.append('line').attr('class', 'pt-chart-cursor').attr('y1', m.t).attr('y2', H - m.b);
  // Click or drag on the chart to move the probe cursor.
  const pick = (e) => setProbeTraceRank(Math.round(x.invert(d3.pointer(e)[0])) - 1);
  svg.append('rect').attr('x', m.l).attr('y', m.t).attr('width', W - m.l - m.r).attr('height', H - m.t - m.b)
    .attr('fill', 'transparent').style('cursor', 'ew-resize')
    .on('click', pick).call(d3.drag().on('drag', pick));
  ptrace.chartX = x;
}

/** Show probes 0..rank: toggles visibility only, no re-layout. */
function updateProbeTrace() {
  const L = ptrace.layout, ps = ptrace.data?.postings ?? [];
  if (!L || !ps.length) return;
  const r = ptrace.rank;
  d3.select('#pt-graph .pt-nodes').selectAll('circle')
    .attr('display', n => (n.p.rank <= r ? null : 'none'))
    .classed('pt-current', n => n.p.rank === r);
  d3.select('#pt-graph .pt-links').selectAll('line')
    .attr('display', l => (l.rank <= r ? null : 'none'))
    .classed('pt-current', l => l.rank === r);
  const shown = ptrace.selected != null && ptrace.selected <= r ? ptrace.selected : r;
  const cur = L.posting[shown];
  d3.select('#pt-graph .pt-cursor').attr('cx', cur.x).attr('cy', cur.y).attr('r', cur.r + 5);
  if (ptrace.chartX) {
    const cx = ptrace.chartX(r + 1);
    d3.select('#pt-chart .pt-chart-cursor').attr('x1', cx).attr('x2', cx);
  }
  const slider = document.getElementById('pt-rank');
  if (slider) slider.value = r + 1;
  const docsSoFar = ps.slice(0, r + 1).reduce((s, p) => s + p.documents, 0);
  const label = document.getElementById('pt-rank-label');
  if (label) label.textContent = `${r + 1} of ${ps.length} postings probed · ${fmt(docsSoFar)} documents scored`;
  renderProbeTracePanel(ps[shown], shown === r);
}

function renderProbeTracePanel(p, isCurrent) {
  const el = document.getElementById('pt-panel');
  if (!el || !p) return;
  const d = ptrace.data;
  const idLink = (s) => (s
    ? `<a class="pt-doc" onclick='showProbeTraceDoc(${JSON.stringify(s.id)})' title="Show the document">${esc(String(s.id))}</a>`
    : '—');
  const swatch = (s) => (s ? `<span class="pt-swatch" style="background:${ptrace.color(s.dot_product)}"></span>` : '');
  el.innerHTML = `
    <div class="admin-card-title">${isCurrent ? 'CURRENT PROBE' : 'SELECTED POSTING'}</div>
    ${vrow('Probe', `${p.rank + 1} of ${d.postings.length}`, '', 'Rank by distance from the query; 1 is the nearest posting.')}
    ${vrow('Posting', p.posting_id, '', 'The posting (cluster) id.')}
    ${vrow('Centre', p.centre_id ?? '—', '', 'The centre new codes in this posting are encoded against.')}
    ${vrow('Distance', num3(p.distance), '', 'Euclidean distance from the query to the posting\'s routing centroid: what probing ranks postings by.')}
    ${vrow('Documents', fmt(p.documents), '', 'Documents with chunks in this posting that were scored.')}
    ${vrow('Max score', `${swatch(p.max)}${num3(p.max?.dot_product)}`, '', 'Highest Pass-1 score in the posting: its best document\'s best chunk.')}
    ${vrow('Max doc', idLink(p.max))}
    ${vrow('Min score', num3(p.min?.dot_product), '', 'Lowest Pass-1 score in the posting (each document by its best chunk here).')}
    ${vrow('Min doc', idLink(p.min))}
    <div class="text-muted pt-panel-note">${fmt(d.active_postings)} active postings · ${d.pass1_bits}-bit Pass-1 codes</div>`;
}

async function showProbeTraceDoc(id) {
  const ns = ptrace.ns;
  const kv = vopsStore()?.store_type === 'kv';
  try {
    const doc = kv ? await Api.getKv(ns, id) : await Api.getDoc(ns, id);
    openModal(`<div class="modal-title">${kv ? 'Key' : 'Document'} ${esc(String(id))}</div>
      <pre class="pt-doc-json">${esc(JSON.stringify(doc, null, 2))}</pre>
      <div class="admin-actions"><button class="btn btn-secondary" onclick="closeModal()">Close</button></div>`);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── Stepping ─────────────────────────────────────────────────────────────────
function setProbeTraceRank(r) {
  const n = ptrace.data?.postings?.length ?? 0;
  if (!n) return;
  ptrace.rank = Math.max(0, Math.min(n - 1, r));
  ptrace.selected = null;
  updateProbeTrace();
}

function stopProbeTracePlay() {
  if (ptrace.timer) clearInterval(ptrace.timer);
  ptrace.timer = null;
  const b = document.getElementById('pt-play');
  if (b) b.textContent = '▶ Play';
}

function toggleProbeTracePlay() {
  const n = ptrace.data?.postings?.length ?? 0;
  if (ptrace.timer) { stopProbeTracePlay(); return; }
  if (!n) return;
  if (ptrace.rank >= n - 1) ptrace.rank = -1;
  // About eight seconds for the whole walk, whatever its length.
  const step = Math.max(25, Math.min(400, 8000 / n));
  ptrace.timer = setInterval(() => {
    if (!document.getElementById('pt-graph') || ptrace.rank >= n - 1) { stopProbeTracePlay(); return; }
    setProbeTraceRank(ptrace.rank + 1);
  }, step);
  const b = document.getElementById('pt-play');
  if (b) b.textContent = '❚❚ Pause';
}
