// ── Probe trace sub-tab ──────────────────────────────────────────────────────
// One query's walk through a store's IVF partition: a window of the postings in
// probe order (nearest first), each with its document count and its lowest and
// highest Pass-1 score, plus a normal search of the same query: the Pass-2 score
// of its last result, and whether it returns each reported document
// (GET /admin/indices/{ns}/vector/probe-trace).
// The window can sit anywhere in the order but is at most 1,024 postings wide,
// what the graph shows usefully.
//
// Drawn with d3 as a force-directed graph: the query in the middle and one node
// per probed posting, linked to the query at a length set by its distance. The
// layout is computed once per trace, off screen; stepping through the probes
// only shows or hides nodes, so a trace of a thousand postings stays responsive.

const ptrace = {
  ns: null,
  query: '',
  from: null,       // first probe shown in the form, 1-based (API start = from - 1)
  topK: null,       // results the baseline search returns (null: the store's top_k)
  to: null,         // last probe, inclusive (API end = to)
  data: null,       // the endpoint's response
  layout: null,     // { nodes, links } with fixed positions, built once per trace
  rank: 0,          // index into the window: its postings 0..rank are shown
  selected: null,   // window index shown in the side panel (null: the current probe)
  timer: null,
  loading: false,
  error: null,
};

const PT_MAX_WINDOW = 1024;
/** Most results the trace's baseline search can return (the API's MAX_TRACE_TOP_K). */
const PT_MAX_TOP_K = 10000;

/** A posting's best document scores above the search's last result, yet the search does not return it. */
function probeTraceMissed(p, data = ptrace.data) {
  const bar = data?.baseline?.lowest_pass2;
  return bar != null && p.max?.in_results === false && p.max.pass2 != null && p.max.pass2 > bar;
}

function resetProbeTrace(ns) {
  stopProbeTracePlay();
  Object.assign(ptrace, { ns, data: null, layout: null, rank: 0, selected: null, error: null, topK: null });
}

function renderVopsTrace() {
  if (ptrace.ns !== vops.ns) resetProbeTrace(vops.ns);
  const postings = vops.partition?.postings ?? null;
  const from = ptrace.from ?? 1;
  const to = ptrace.to ?? Math.min(effectiveProbes(vopsSettings(), postings ?? Infinity) ?? 64, PT_MAX_WINDOW);
  const maxAttr = postings != null ? `max="${postings}"` : '';
  const storeTopK = vopsSettings()?.search?.top_k ?? null;
  const topK = ptrace.topK ?? storeTopK ?? 100;
  const searchTip = postings == null ? 'its max_probes' : `${effectiveProbes(vopsSettings(), postings)} of ${postings}`;
  const d = ptrace.data;
  const n = d?.postings?.length ?? 0;
  return `
    <div class="section">
      <div class="section-header"><span class="section-title"
        title="Embeds the query as a search does, ranks every posting by distance from it, then scores every document in the chosen window of postings with the store's Pass-1 codes. Also runs the store's own search, for the score its last result has.">PROBE TRACE</span></div>
      <form class="pt-form" onsubmit="event.preventDefault(); runProbeTrace()">
        <input id="pt-query" class="pt-query" type="text" placeholder="Query text" value="${esc(ptrace.query)}" required>
        <label class="pt-label" title="Probes are numbered by distance from the query: 1 is the nearest posting${postings != null ? `, ${postings} the farthest` : ''}. A window holds up to ${fmt(PT_MAX_WINDOW)} probes. The store probes ${searchTip} on a search.">
          Probes <input id="pt-from" type="number" min="1" ${maxAttr} value="${from}" oninput="probeTraceFromChanged()">
          to <input id="pt-to" type="number" min="1" ${maxAttr} value="${to}">
        </label>
        <label class="pt-label" title="Results the comparison search returns: up to ${fmt(PT_MAX_TOP_K)}. A larger top_k reaches further down the ranking, so the lowest search result falls and fewer documents count as missed. Its Pass 1 keeps the store's first_pass_top_k candidates, or top_k when that is more. The store's own settings do not change.${storeTopK != null ? ` The store returns ${fmt(storeTopK)}.` : ''}">
          Top k <input id="pt-top-k" type="number" min="1" max="${PT_MAX_TOP_K}" value="${topK}">
        </label>
        <span class="text-muted pt-hint">${postings != null ? `of ${fmt(postings)} postings · ` : ''}up to ${fmt(PT_MAX_WINDOW)} at a time</span>
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
        <span class="pt-store-note">
          <span title="Postings (clusters) the store's partition has, not counting retired ones. Probes are numbered 1 to ${fmt(d.active_postings)} by distance from the query.">${fmt(d.active_postings)} active postings</span>
          · <span title="Bits per dimension of the store's Pass-1 chunk codes (its pass1_bits: 1, 2 or 4). Fewer bits make Pass-1 scores rougher estimates.">${d.pass1_bits}-bit Pass-1 codes</span>
          ${d.baseline ? `· <span title="Nearest postings the store's normal search reads (its max_probes, or every posting of a smaller store). The chart's dotted line marks where it stops; postings past it are never read by a search.">search probes ${fmt(d.baseline.n_probes)}</span>
          · <span title="Results the comparison search returns at most, and the Pass-1 candidates it re-ranks to choose them (the store's first_pass_top_k, or top_k when that is more).">top_k ${fmt(d.baseline.top_k)} of ${fmt(d.baseline.first_pass_top_k)} candidates</span>` : ''}
        </span>
      </div>
      <div class="pt-layout">
        <div class="pt-graph-wrap">
          <svg id="pt-graph" class="pt-graph" role="img" aria-label="Probed postings around the query"></svg>
          <div class="pt-legend" id="pt-legend"></div>
          <div class="pt-tip" id="pt-tip" hidden></div>
        </div>
        <div class="admin-card pt-panel" id="pt-panel"></div>
      </div>
      <div class="pt-chart-title" title="Each probe's lowest and highest Pass-1 document score, and the Pass-2 score (what results are ranked by) of its highest-scoring document. The highest falls as probes reach postings farther from the query: they add less and less to Pass 1's candidates.">
        Score by probe <span class="pt-key pt-key-band"></span>Pass-1 range
        <span class="pt-key pt-key-max"></span>Pass-1 max <span class="pt-key pt-key-pass2"></span>Pass 2 of that document
        ${d.baseline?.lowest_pass2 != null ? `<span class="pt-key pt-key-base"></span><span title="The Pass-2 score of the last of the ${fmt(d.baseline.results)} results the store's own search returns for this query (top_k ${fmt(d.baseline.top_k)}, ${fmt(d.baseline.n_probes)} probes, ${fmt(d.baseline.first_pass_top_k)} Pass-1 candidates). A document must score above it to be returned.">lowest search result</span>
        <span class="pt-key-dot"></span><span title="The posting's highest-scoring document scores above the lowest search result in Pass 2, but the search does not return it: Pass 1 never made it a candidate. Only each posting's lowest and highest Pass-1 documents are checked.">missed by the search</span>` : ''}</div>
      <svg id="pt-chart" class="pt-chart" role="img" aria-label="Pass-1 score range and the best document's Pass-2 score per probe"></svg>
    </div>` : ''}`;
}

/** Keep the window valid when its first probe moves: "to" follows within the limit. */
function probeTraceFromChanged() {
  const fromEl = document.getElementById('pt-from'), toEl = document.getElementById('pt-to');
  const from = fromEl?.valueAsNumber, to = toEl?.valueAsNumber;
  if (!(from >= 1) || !toEl) return;
  const last = vops.partition?.postings ?? Infinity;
  if (!(to >= from) || to - from + 1 > PT_MAX_WINDOW) toEl.value = Math.min(from + PT_MAX_WINDOW - 1, last);
}

async function runProbeTrace() {
  const query = document.getElementById('pt-query')?.value.trim();
  const from = document.getElementById('pt-from')?.valueAsNumber;
  const to = document.getElementById('pt-to')?.valueAsNumber;
  const topK = document.getElementById('pt-top-k')?.valueAsNumber;
  if (!query) return;
  const postings = vops.partition?.postings;
  const problem = !(Number.isInteger(from) && Number.isInteger(to) && from >= 1) ? 'Probes must be whole numbers from 1.'
    : to < from ? `The last probe (${to}) is before the first (${from}).`
    : to - from + 1 > PT_MAX_WINDOW ? `A window holds at most ${fmt(PT_MAX_WINDOW)} probes; ${from} to ${to} is ${fmt(to - from + 1)}.`
    : postings != null && to > postings ? `The store has ${fmt(postings)} postings; the last probe can be at most ${fmt(postings)}.`
    : !(Number.isInteger(topK) && topK >= 1 && topK <= PT_MAX_TOP_K) ? `Top k must be a whole number from 1 to ${fmt(PT_MAX_TOP_K)}.`
    : null;
  if (problem) {
    ptrace.error = problem;
    renderVopsBody();
    return;
  }
  stopProbeTracePlay();
  Object.assign(ptrace, { query, from, to, topK, loading: true, error: null });
  renderVopsBody();
  const ns = ptrace.ns;
  try {
    const data = await Api.vectorProbeTrace(ns, query, from - 1, to, topK);
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
    // i: position in the window, what stepping counts in (p.rank is the absolute probe rank).
    nodes.push({ id: p.posting_id, p, i, x: rr * Math.cos(a), y: rr * Math.sin(a), r: docs(p.documents) });
    links.push({ source: 'q', target: p.posting_id, len: rr, i });
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
    .classed('pt-missed', n => probeTraceMissed(n.p))
    .on('mouseenter', (e, n) => {
      tip.hidden = false;
      tip.innerHTML = `<b>Posting ${n.p.posting_id}</b> · probe ${fmt(n.p.rank + 1)}<br>
        ${fmt(n.p.documents)} documents · distance ${num3(n.p.distance)}<br>
        Pass 1: max ${num3(n.p.max?.dot_product)} · min ${num3(n.p.min?.dot_product)}<br>
        Pass 2 of max doc: ${num3(n.p.max?.pass2)}${n.p.max?.in_results != null ? (n.p.max.in_results ? ' · in the results' : ' · not in the results') : ''}
        ${probeTraceMissed(n.p) ? '<br><b class="pt-missed-text">Missed: scores above the lowest result</b>' : ''}`;
    })
    .on('mousemove', e => {
      const box = svgEl.parentElement.getBoundingClientRect();
      tip.style.left = `${e.clientX - box.left + 12}px`;
      tip.style.top = `${e.clientY - box.top + 12}px`;
    })
    .on('mouseleave', () => { tip.hidden = true; })
    .on('click', (e, n) => { ptrace.selected = n.i; updateProbeTrace(); });

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
  const base = ptrace.data.baseline;
  const bar = base?.lowest_pass2 ?? null;
  // Probe numbers on the axis are absolute (1 is the nearest posting), whatever the window.
  const first = ps[0].rank + 1, last = ps[ps.length - 1].rank + 1;
  const x = d3.scaleLinear().domain([first, Math.max(last, first + 1)]).range([m.l, W - m.r]);
  const y = d3.scaleLinear()
    .domain([
      Math.min(0, d3.min(scored, p => Math.min(p.min.dot_product, p.max.pass2 ?? Infinity)) ?? 0, bar ?? Infinity),
      Math.max(d3.max(scored, p => Math.max(p.max.dot_product, p.max.pass2 ?? -Infinity)) ?? 1, bar ?? -Infinity),
    ]).nice()
    .range([H - m.b, m.t]);
  svg.append('g').attr('class', 'pt-axis').attr('transform', `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).ticks(Math.min(ps.length, 10)).tickFormat(d3.format('d')));
  // Where the store's own search stops probing, when that falls inside the window.
  const edge = base?.n_probes;
  if (edge != null && edge >= first && edge < last) {
    const ex = (x(edge) + x(edge + 1)) / 2;
    svg.append('line').attr('class', 'pt-search-edge').attr('x1', ex).attr('x2', ex).attr('y1', m.t).attr('y2', H - m.b);
    svg.append('text').attr('class', 'pt-axis-label').attr('x', ex + 4).attr('y', m.t + 10)
      .text(`search stops (${fmt(edge)} probes)`);
  }
  svg.append('g').attr('class', 'pt-axis').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5));
  svg.append('text').attr('class', 'pt-axis-label').attr('x', W - m.r).attr('y', H - 2).attr('text-anchor', 'end').text('probe (nearest first)');
  svg.append('line').attr('class', 'pt-zero').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(0)).attr('y2', y(0));
  svg.append('path').attr('class', 'pt-band').datum(scored)
    .attr('d', d3.area().x(p => x(p.rank + 1)).y0(p => y(p.min.dot_product)).y1(p => y(p.max.dot_product)));
  svg.append('path').attr('class', 'pt-max-line').datum(scored)
    .attr('d', d3.line().x(p => x(p.rank + 1)).y(p => y(p.max.dot_product)));
  svg.append('path').attr('class', 'pt-pass2-line').datum(scored.filter(p => p.max.pass2 != null))
    .attr('d', d3.line().x(p => x(p.rank + 1)).y(p => y(p.max.pass2)));
  if (bar != null) {
    svg.append('line').attr('class', 'pt-baseline-line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(bar)).attr('y2', y(bar));
  }
  svg.append('g').selectAll('circle').data(scored.filter(p => probeTraceMissed(p))).join('circle')
    .attr('class', 'pt-missed-dot').attr('r', 3.5).attr('cx', p => x(p.rank + 1)).attr('cy', p => y(p.max.pass2));
  svg.append('line').attr('class', 'pt-chart-cursor').attr('y1', m.t).attr('y2', H - m.b);
  // Click or drag on the chart to move the probe cursor.
  const pick = (e) => setProbeTraceRank(Math.round(x.invert(d3.pointer(e)[0])) - first);
  svg.append('rect').attr('x', m.l).attr('y', m.t).attr('width', W - m.l - m.r).attr('height', H - m.t - m.b)
    .attr('fill', 'transparent').style('cursor', 'ew-resize')
    .on('click', pick).call(d3.drag().on('drag', pick));
  ptrace.chartX = x;
}

/** Show the window's postings 0..rank: toggles visibility only, no re-layout. */
function updateProbeTrace() {
  const L = ptrace.layout, ps = ptrace.data?.postings ?? [];
  if (!L || !ps.length) return;
  const r = ptrace.rank;
  d3.select('#pt-graph .pt-nodes').selectAll('circle')
    .attr('display', n => (n.i <= r ? null : 'none'))
    .classed('pt-current', n => n.i === r);
  d3.select('#pt-graph .pt-links').selectAll('line')
    .attr('display', l => (l.i <= r ? null : 'none'))
    .classed('pt-current', l => l.i === r);
  const shown = ptrace.selected != null && ptrace.selected <= r ? ptrace.selected : r;
  const cur = L.posting[shown];
  d3.select('#pt-graph .pt-cursor').attr('cx', cur.x).attr('cy', cur.y).attr('r', cur.r + 5);
  if (ptrace.chartX) {
    const cx = ptrace.chartX(ps[r].rank + 1);
    d3.select('#pt-chart .pt-chart-cursor').attr('x1', cx).attr('x2', cx);
  }
  const slider = document.getElementById('pt-rank');
  if (slider) slider.value = r + 1;
  const docsSoFar = ps.slice(0, r + 1).reduce((s, p) => s + p.documents, 0);
  const label = document.getElementById('pt-rank-label');
  if (label) {
    const d = ptrace.data;
    const span = d.start === 0 ? '' : ` (probes ${fmt(d.start + 1)}–${fmt(d.end)})`;
    label.textContent = `probe ${fmt(ps[r].rank + 1)} · ${fmt(r + 1)} of ${fmt(ps.length)} in the window${span} · ${fmt(docsSoFar)} documents scored`;
  }
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
  const bar = d.baseline?.lowest_pass2 ?? null;
  const inResultsTip = `Whether the store's own search for this query (${fmt(d.baseline?.n_probes)} probes, top_k ${fmt(d.baseline?.top_k)}) returns the document. Its last result scores ${num3(bar)} in Pass 2: a document above that but not returned was missed, because Pass 1 never made it a candidate.`;
  const inResults = (s) => {
    if (s?.in_results == null) return '—';
    if (s.in_results) return 'yes';
    const missed = bar != null && s.pass2 != null && s.pass2 > bar;
    return missed ? '<span class="pt-missed-text" title="Scores above the last result in Pass 2, but the search does not return it">no, missed</span>' : 'no';
  };
  // The posting's two reported documents side by side: one row per measure.
  const pair = (label, tip, cell) => `
      <tr><th scope="row"><span class="stat-key" title="${esc(tip)}">${label}</span></th>
        <td class="stat-val">${cell(p.max)}</td><td class="stat-val">${cell(p.min)}</td></tr>`;
  const showInResults = p.max?.in_results != null || p.min?.in_results != null;
  el.innerHTML = `
    <div class="admin-card-title">${isCurrent ? 'CURRENT PROBE' : 'SELECTED POSTING'}</div>
    ${vrow('Probe', `${fmt(p.rank + 1)} of ${fmt(d.active_postings)}`, '', 'Rank by distance from the query; 1 is the nearest posting.')}
    ${vrow('Posting', p.posting_id, '', 'The posting (cluster) id.')}
    ${vrow('Centre', p.centre_id ?? '—', '', 'The centre new codes in this posting are encoded against.')}
    ${vrow('Distance', num3(p.distance), '', 'Euclidean distance from the query to the posting\'s routing centroid: what probing ranks postings by.')}
    ${vrow('Documents', fmt(p.documents), '', 'Documents with chunks in this posting that were scored.')}
    <table class="pt-pair">
      <thead><tr><th></th>
        <th scope="col"><span class="stat-key" title="The document with the highest Pass-1 score in this posting (by its best chunk here).">Max</span></th>
        <th scope="col"><span class="stat-key" title="The document with the lowest Pass-1 score in this posting (each document by its best chunk here).">Min</span></th></tr></thead>
      <tbody>
      ${pair('Document', 'The document\'s id. Click it to open the document.', idLink)}
      ${pair('Pass-1 score', 'The document\'s best chunk here, scored with the store\'s Pass-1 codes against the query. The node\'s colour is the Max score.', (s) => (s ? `${s === p.max ? swatch(s) : ''}${num3(s.dot_product)}` : '—'))}
      ${pair('Pass-2 score', 'The document\'s Pass-2 score: its whole-document code against the query, what search results are ranked by.', (s) => num3(s?.pass2))}
      ${showInResults ? pair('In search results', inResultsTip, inResults) : ''}
      </tbody>
    </table>`;
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
