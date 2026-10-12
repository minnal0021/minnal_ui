/**
 * vector_ops.js — Admin → Vector Index Ops: one semantic-search store at a time.
 *
 * Everything here is per namespace (chosen in the tab's own selector): the
 * store's partition (postings, sizes, maintenance), its code metrics (centre
 * drift and friends), the recall check that says whether a rebuild helps, the
 * rebuild itself, the recorded history of all three, and the store's
 * vector-index settings beside the server's defaults.
 *
 * Endpoints (minnal branch dynamic-rabitq-index):
 *   GET  /admin/indices/{ns}/vector/partition[?codes=true]
 *   GET  /admin/indices/{ns}/vector/postings
 *   GET  /admin/indices/{ns}/vector/recall-check
 *   POST /admin/indices/{ns}/vector/rebuild
 *   GET  /admin/indices/{ns}/vector/history
 *   GET  /admin/indices/{ns}/vector/corruption-metrics
 *   GET  /admin/indices/vector/settings
 */

const vops = {
  ns:          null,
  sub:         'decision',   // decision | partition | codes | postings | history | settings
  partition:   null,         // GET partition (memory only)
  corruption:  null,         // per-namespace corruption counters
  history:     [],           // every record, newest first
  historyTtl:  null,         // seconds
  server:      null,         // GET /admin/indices/vector/settings (server-wide)
  lastCheck:   null,         // the check run from this page, if any
  checking:    false,
  computingCodes: false,
  postings:    { sort: 'id', order: 'asc', codes: false, limit: 100, stack: [null], idx: 0, data: null, next: null },
  allPostings: null,         // every posting (for the size histogram)
  historyKind: 'all',
  rebuildPoll: null,
  loadError:   null,
};

// ── Explanations (tooltips and the help blocks) ──────────────────────────────
// Kept in one place: today's review found these terms easy to mix up, so every
// label in the tab says what it measures and what to do about it.
const VTIP = {
  // partition shape
  postings: 'Live postings (IVF clusters) a search can probe. Each holds the chunks nearest its centre. Searches walk the nearest postings until the probe budget is spent.',
  retired: 'Postings emptied by a split, merge or rebuild. Kept only as small records (for the split/merge lineage); never searched, hold no keys.',
  centres: 'Centres stored, including those of retired postings. A chunk code keeps the centre it was encoded against until the document is re-embedded, so old centres stay.',
  entries: 'One per (document, posting) pair: a document whose chunks fall in 3 postings counts 3. The probe budget is counted in entries.',
  chunks: 'Sentence-window chunks indexed for Pass 1 (one 1-bit code each), across live postings.',
  sizes: 'Chunks per live posting: 10th, 50th and 90th percentile, and the largest. A posting splits above the split limit and merges at or below the merge limit.',
  target: 'target_posting_size: the posting size maintenance aims for, in chunks.',
  split_limit: 'A posting holding more chunks than this (2 × target) is split in two by the maintenance task.',
  merge_limit: 'A posting holding this many chunks or fewer (split limit × merge_ratio) is merged into a nearby posting.',
  splits_total: 'Postings created by a split, halved: the splits since the namespace began (from the stored lineage).',
  unfinished: 'Maintenance operations (split, reassign, merge, rebuild) a crash interrupted. They are finished at startup; should be 0 on a running server.',
  // maintenance since load
  m_splits: 'Postings split since the partition loaded (server start or first use).',
  m_merges: 'Small postings merged away since the partition loaded.',
  m_reassigns: 'Reassignment passes run after splits (LIRE: chunks in the split posting and its neighbours that may now be nearer another posting).',
  m_reassign_candidates: 'Chunks the reassignment passes found might be nearer another posting.',
  m_reassign_moves: 'Of those, chunks actually moved to another posting.',
  m_drain_moves: 'Chunks copied out of postings that a split or merge drained.',
  m_rebuilds: 'Rebuilds run since the partition loaded.',
  m_rebuild_moves: 'Chunks a rebuild moved into its fitted postings (every chunk, once per rebuild).',
  m_moves_total: 'All chunk moves by ongoing maintenance (reassign + drain), excluding rebuilds: the write cost of keeping the partition in shape.',
  // corruption
  c_sparse: 'Pass-1 (1-bit chunk) entries search skipped because they did not decode, since server start. Should be 0; if not, run the validating reconcile (Admin → Index Management).',
  c_dense: 'Pass-2 (8-bit whole-document) entries search skipped because they did not decode, since server start. Should be 0.',
  c_total: 'Sum of the two. Any non-zero value means some documents are silently missing from search results.',
  // rebuild
  rb_state: 'running, done or failed: the last rebuild of this store since the server started.',
  rb_requested: 'Postings asked for. Empty: as many as were active, so searches probe about as many as before.',
  rb_before: 'Active postings before the rebuild.',
  rb_fitted: 'Postings k-means fitted (a centre no chunk was nearest is dropped).',
  rb_after: 'Active postings after the follow-up splits (k-means does not balance sizes, so a few oversized postings are split).',
  rb_chunks: 'Chunks the rebuild read and moved.',
  rb_iterations: 'k-means (Lloyd) iterations run.',
  rb_moved: 'Chunks moved into the fitted postings.',
  // codes
  foreign: 'Share of chunk codes encoded against a different centre from their current posting\'s. A split, merge or rebuild moves a chunk without re-encoding it. Search scores every code against its own centre, so a foreign code is still scored correctly, only a little less precisely.',
  zero_centre: 'Share of codes still encoded against the zero centre: written while the store was one root posting, before its first split. Scored correctly; re-embedding encodes them against a real centre.',
  drift_mean: 'Centre drift = ‖c − c′‖ / ‖r‖: how far the code\'s current posting centre c′ is from the centre c it was encoded against, relative to the code\'s residual length ‖r‖. 0 = the code sits in the posting it was encoded in. It measures CODE PRECISION, not partition quality. A rebuild RAISES it (moves every code, re-encodes none); only re-embedding (vector reindex-all) resets it.',
  drift_p90: '90th percentile of centre drift over the codes: the tail of the codes that have moved furthest.',
  error_band: 'Mean error_bound of the 1-bit codes, in score units: the width of the estimator\'s confidence band, proportional to each code\'s residual length. Larger = less precise Pass-1 scores.',
  reencode: 'The (up to) 20 postings with the highest mean drift: where re-embedding would restore the most code precision. NOT a reason to rebuild.',
  // recall check
  verdict: 'read_in_full: every search already reads every posting, so no partition can change its results. ok: overlap@10 ≥ the threshold. below_target: searches miss part of what a full read finds. empty: nothing stored.',
  overlap: 'Overlap@k: of the top k documents a full read (every posting) returns, the share the normal search also returns within its probe budget. 1.0 = the budget loses nothing. Compare a check before and after a change (same seed), not against a fixed bar: the level differs by data.',
  overlap_p10: '10th percentile of overlap@10 over the sampled queries: how bad the worst tenth of queries are.',
  query_source: 'cached_queries: real recent queries from the query-embedding cache (the reliable signal). stored_chunks: fewer than 20 queries were cached, so stored chunks were used as queries; they can miss what a rebuild does for real queries.',
  seed: 'The sample\'s seed. Re-run with the same seed to search the same queries, e.g. before and after a rebuild.',
  sampled: 'Queries searched (each twice: normal search and full read).',
  budget: 'The probe budget (entries) the normal search used: the store\'s, or this check\'s override.',
  read_share: 'Mean share of the store\'s entries one normal search read. Near 1.0, a rebuild cannot change results.',
  probes_mean: 'Mean postings one normal search probed.',
  reference_full: 'Whether the reference search read every posting. Above 500,000 entries it reads the nearest postings up to that many instead (memory bound), so the reference is not a full read.',
  reference_share: 'Mean share of entries the reference search read.',
  search_ms: 'Mean time of a normal search during the check.',
  full_read_ms: 'Mean time of a full read during the check. The check costs about sample × (search + full read).',
  elapsed_ms: 'Wall time of the whole check.',
  min_overlap: 'Overlap@10 below which the verdict is below_target.',
  // settings
  embedding_model: 'Embedding model this store asks the service for. Fixed for the store\'s life.',
  embedding_dim: 'Embedding dimension. Fixed for the store\'s life.',
  window_size: 'Sentences per document chunk (sliding window). Fixed: changing it would leave old documents with old chunks.',
  sliding_size: 'Sentences the chunk window advances by. Fixed.',
  pass1_bits: 'Bits per dimension of chunk (Pass-1) codes. Read-only.',
  pass2_bits: 'Bits per dimension of whole-document (Pass-2) codes. Read-only.',
  pass2_centre: 'Centre whole-document codes are encoded against ("zero": no partition centre, so they never drift).',
  rotation_seed: 'Seed of the random rotation codes and queries are computed in. Read-only.',
  probe_budget_entries: 'Entries Pass 1 reads per query (the probe budget). Changeable; overridable per request. Raising it is the remedy when a rebuild does not raise overlap.',
  min_probes: 'Postings always probed, whatever the budget.',
  max_probes: 'Postings never exceeded, whatever the budget.',
  first_pass_top_k: 'Candidates Pass 1 hands to Pass 2 for re-ranking.',
  top_k: 'Results returned by default.',
  probe_budget_fraction: 'Scaled budget: clamp(fraction × entries, floor, probe_budget_entries). 0 / empty = the absolute budget.',
  probe_budget_floor: 'Smallest scaled budget, so a small store is still read in full (used only with probe_budget_fraction).',
  target_posting_size: 'Target posting size in chunks; split above 2 × target.',
  reassign_range: 'Nearest postings re-checked after a split (LIRE reassignment).',
  merge_ratio: 'Merge limit as a share of the split limit.',
  skip_uncertain_moves: 'Skip reassignment moves whose gain is within the code\'s error bound.',
  split_samples: 'Balanced 2-means: members sampled per iteration.',
  split_init_trials: 'Balanced 2-means: random starting pairs tried.',
  split_max_iters: 'Balanced 2-means: iteration cap.',
  split_lambda_factor: 'Balanced 2-means: balance factor (how strongly it keeps the halves equal).',
  // server
  embedding_service_url: 'Where the server sends embedding requests. Server-wide.',
  supported_models: 'Models stores may use (name → dimension). Empty: any model the embedding service serves.',
  embedding_request_timeout_secs: 'Overall timeout of one embedding request.',
  embedding_connect_timeout_secs: 'Connect timeout of one embedding request.',
  query_embedding_cache_ttl_secs: 'How long a query\'s embedding is cached. The recall check samples these cached queries.',
  partition_history_ttl_secs: 'How long recall checks, code-health reads and rebuilds are kept in the history (partition_history_ttl_secs).',
  maintenance_threads: 'Namespaces the partition maintenance task maintains at once.',
  rebuild_threads: 'Threads a rebuild\'s k-means uses (on its own pool, never the search pool).',
  max_rebuild_threads: 'Hard cap on rebuild threads.',
  max_sample: 'Most queries one recall check may sample.',
  min_cached_queries: 'Fewer cached queries than this and the check uses stored chunks instead.',
  max_reference_entries: 'Most entries the check\'s reference search reads (its memory bound).',
  default_min_overlap: 'Default overlap@10 threshold of the recall check.',
  effective_probe_budget: 'The budget a search on this store uses now: probe_budget_entries, or the scaled form clamp(fraction × entries, floor, probe_budget_entries) when probe_budget_fraction is set.',
};

const vt = (k) => VTIP[k] ?? '';
const vrow = (k, v, cls, tip) =>
  `<div class="stat-row"><span class="stat-key"${tip ? ` title="${esc(tip)}"` : ''}>${k}</span>
   <span class="stat-val ${cls ?? ''}">${v}</span></div>`;
const pct = (x, d = 1) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const num3 = (x) => (x == null ? '—' : Number(x).toFixed(3));
const when = (ms) => (ms ? new Date(ms).toLocaleString() : '—');
const ago = (ms) => {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return `${Math.round(s)} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
const durMs = (ms) => (ms == null ? '—' : ms < 1000 ? `${ms.toFixed(1)} ms` : `${(ms / 1000).toFixed(2)} s`);

function semanticStores() {
  return [...state.stores, ...state.kvStores]
    .filter(s => s.semantic_search_enabled)
    .sort((a, b) => a.namespace.localeCompare(b.namespace));
}
function vopsStore() { return semanticStores().find(s => s.namespace === vops.ns) ?? null; }
function vopsSettings() { return vopsStore()?.vector_index ?? null; }

/** The budget a search uses on this store now (the scaled form when set). */
function effectiveBudget(settings, entries) {
  const s = settings?.search;
  if (!s) return null;
  const f = s.probe_budget_fraction ?? 0;
  if (f > 0) return Math.min(Math.max(Math.round(f * entries), s.probe_budget_floor ?? 0), s.probe_budget_entries);
  return s.probe_budget_entries;
}

// ── Tab entry ────────────────────────────────────────────────────────────────
function renderVectorOpsTab() {
  const el = document.getElementById('admin-vector-ops-panel');
  if (!el) return;
  const stores = semanticStores();
  if (!stores.length) {
    el.innerHTML = `<div class="welcome"><p class="welcome-icon">🧭</p>
      <p>No store has semantic search enabled. Enable it on a store (Schema tab) to see its vector index here.</p></div>`;
    return;
  }
  const sel = state.selectedStore;
  if (sel?.semantic_search_enabled && sel.namespace !== vops.ns && vops._followSidebar !== false) vops.ns = sel.namespace;
  if (!stores.some(s => s.namespace === vops.ns)) vops.ns = stores[0].namespace;

  const tabs = [
    ['decision', 'Rebuild decision'],
    ['partition', 'Partition'],
    ['codes', 'Code metrics'],
    ['postings', 'Postings'],
    ['history', 'History'],
    ['settings', 'Settings'],
  ];
  el.innerHTML = `
    <div class="section vops-head">
      <div class="section-header">
        <span class="section-title" title="Everything on this panel is for the selected store. Server-wide values are marked as such.">VECTOR INDEX OPS</span>
        <div class="vops-ns">
          <label for="vops-ns-select" class="text-muted">Store</label>
          <select id="vops-ns-select" onchange="onVopsNsChange()">
            ${stores.map(s => `<option value="${esc(s.namespace)}" ${s.namespace === vops.ns ? 'selected' : ''}>${esc(s.namespace)} (${esc(s.store_type ?? 'doc')})</option>`).join('')}
          </select>
          <button class="btn btn-secondary btn-sm" onclick="loadVectorOps()">↻ Refresh</button>
        </div>
      </div>
      <div class="sub-tab-nav">
        ${tabs.map(([id, label]) => `<button class="sub-tab-btn ${vops.sub === id ? 'active' : ''}" data-vops-tab="${id}" onclick="switchVopsTab('${id}')">${label}</button>`).join('')}
      </div>
    </div>
    <div id="vops-body"><div class="spinner"></div></div>`;
  loadVectorOps();
}

function onVopsNsChange() {
  vops.ns = document.getElementById('vops-ns-select').value;
  vops._followSidebar = false;
  vops.lastCheck = null;
  vops.allPostings = null;
  vops.postings = { ...vops.postings, stack: [null], idx: 0, data: null, next: null };
  loadVectorOps();
}

function switchVopsTab(id) {
  vops.sub = id;
  document.querySelectorAll('[data-vops-tab]').forEach(b => b.classList.toggle('active', b.dataset.vopsTab === id));
  renderVopsBody();
  if (id === 'postings' && !vops.postings.data) loadVopsPostings();
  if (id === 'partition' && !vops.allPostings) loadVopsAllPostings();
}

async function loadVectorOps() {
  const ns = vops.ns;
  vops.loadError = null;
  const body = document.getElementById('vops-body');
  if (body && !vops.partition) body.innerHTML = '<div class="spinner"></div>';
  const [p, h, c, srv] = await Promise.allSettled([
    Api.vectorPartition(ns, false),
    Api.vectorHistory(ns, null, 1000),
    Api.vectorCorruptionMetricsNs(ns),
    vops.server ? Promise.resolve(vops.server) : Api.vectorServerSettings(),
  ]);
  if (ns !== vops.ns) return; // switched meanwhile
  vops.partition = p.status === 'fulfilled' ? p.value : null;
  if (p.status === 'rejected') vops.loadError = p.reason.message;
  vops.history = h.status === 'fulfilled' ? h.value.records ?? [] : [];
  vops.historyTtl = h.status === 'fulfilled' ? h.value.ttl_secs : null;
  vops.corruption = c.status === 'fulfilled' ? c.value : null;
  if (srv.status === 'fulfilled') vops.server = srv.value;
  renderVopsBody();
  if (vops.sub === 'postings') loadVopsPostings();
  if (vops.sub === 'partition') loadVopsAllPostings();
  if (vops.partition?.rebuild?.state === 'running') startRebuildPoll();
}

function renderVopsBody() {
  const body = document.getElementById('vops-body');
  if (!body) return;
  if (vops.loadError && !vops.partition) {
    body.innerHTML = `<div class="alert alert-error">Could not load the partition of ${esc(vops.ns)}: ${esc(vops.loadError)}.
      This panel needs a minnal server from the dynamic-rabitq-index branch.</div>`;
    return;
  }
  const r = {
    decision: renderVopsDecision,
    partition: renderVopsPartition,
    codes: renderVopsCodes,
    postings: renderVopsPostings,
    history: renderVopsHistory,
    settings: renderVopsSettings,
  }[vops.sub];
  body.innerHTML = r();
}

// ── History helpers ──────────────────────────────────────────────────────────
const checks = () => vops.history.filter(r => r.kind === 'recall_check');
const rebuildsDone = () => vops.history.filter(r => r.kind === 'rebuild' && r.data?.state === 'done');
const codeRecords = () => vops.history.filter(r => r.kind === 'codes');
const ov10 = (d) => d?.overlap?.find(o => o.k === 10)?.mean;

/** Two checks comparable across a rebuild: same seed, query source and budget. */
function sameCheck(a, b) {
  return a && b && a.seed === b.seed && a.query_source === b.query_source && a.budget_entries === b.budget_entries;
}

/**
 * The decision, from the latest recall check, the last rebuild and the budget.
 * Returns { level: good|warn|info|unknown, title, text, steps[] }.
 */
function vopsDecide() {
  const p = vops.partition ?? {};
  const settings = vopsSettings();
  const budget = effectiveBudget(settings, p.entries ?? 0);
  // Only checks run at the store's own budget say what its searches lose; a
  // check with a budget override is a what-if and is shown apart.
  const cs = checks().filter(c => c.data.budget_entries === budget);
  const latest = cs[0];
  const rb = rebuildsDone()[0];
  if (p.rebuild?.state === 'running') {
    return { level: 'info', title: 'A rebuild is running',
      text: 'Wait for it to finish (this page refreshes itself), then run a recall check with the same seed as your last one to see what it gained.', steps: [] };
  }
  if (budget != null && budget >= (p.entries ?? 0) && (p.entries ?? 0) > 0) {
    return { level: 'good', title: 'No rebuild needed',
      text: `Every search reads the whole store: the probe budget (${fmt(budget)} entries) is at least the store's ${fmt(p.entries)} entries. No partition can change what a search finds.`,
      steps: ['This changes once the store grows past the budget; check again then.'] };
  }
  if (!latest) {
    return { level: 'unknown', title: 'Not measured yet',
      text: `Searches read about ${budget && p.entries ? pct(Math.min(1, budget / p.entries), 0) : 'part'} of this store. Run a recall check (without a budget override) to see whether they miss results a full read would find.${checks().length ? ' Checks recorded so far used a budget override, so they describe a different budget.' : ''}`,
      steps: ['Run a recall check (below).', 'If its verdict is below_target, rebuild, then run the check again with the same seed.'] };
  }
  const d = latest.data;
  const o = ov10(d);
  if (rb && rb.recorded_at_ms > latest.recorded_at_ms) {
    return { level: 'info', title: 'Rebuild finished: measure what it gained',
      text: `The last check (overlap@10 ${pct(o)}) ran before the rebuild ${ago(rb.recorded_at_ms)}. Run the same check again to compare.`,
      steps: [`Run the recall check with seed ${d.seed ?? '(same)'}, no budget override (budget ${fmt(d.budget_entries)}).`,
        'Keep the rebuild if overlap rose; if it did not, raise probe_budget_entries instead.'] };
  }
  if (d.verdict === 'read_in_full') {
    return { level: 'good', title: 'No rebuild needed',
      text: 'Every sampled search already read every posting, so no partition can change its results.', steps: [] };
  }
  if (d.verdict === 'empty') {
    return { level: 'unknown', title: 'Nothing stored yet', text: 'The store has no vectors to check.', steps: [] };
  }
  if (d.verdict === 'ok') {
    return { level: 'good', title: 'No rebuild needed',
      text: `Searches find ${pct(o)} of a full read's top 10 (threshold ${pct(d.min_overlap, 0)}), reading ${pct(d.read_share)} of the store.`, steps: [] };
  }
  // below_target
  if (rb && latest.recorded_at_ms > rb.recorded_at_ms) {
    const before = cs.find(c => c.recorded_at_ms < rb.recorded_at_ms && sameCheck(c.data, d));
    if (before) {
      const delta = (o - ov10(before.data)) * 100;
      if (delta >= 1) {
        return { level: 'warn', title: `The last rebuild helped (+${delta.toFixed(1)} points); keep it`,
          text: `Overlap@10 rose from ${pct(ov10(before.data))} to ${pct(o)}, still below ${pct(d.min_overlap, 0)}. The rest of the gap is the probe budget, which no partition fixes.`,
          steps: [`Raise probe_budget_entries (now ${fmt(d.budget_entries)}) if you need more recall, and check again with a budget override first.`] };
      }
      return { level: 'warn', title: 'A rebuild did not help: raise the budget instead',
        text: `Overlap@10 moved ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} points across the last rebuild (${pct(ov10(before.data))} → ${pct(o)}). The partition is not what loses results; the probe budget is.`,
        steps: [`Try the check with a larger probe_budget_entries override (now ${fmt(d.budget_entries)}); if it reaches the target, raise the store's budget.`] };
    }
    return { level: 'warn', title: 'Below target; cannot compare across the last rebuild',
      text: `Overlap@10 is ${pct(o)}. No check from before the last rebuild used the same seed, query source and budget, so its effect is unknown.`,
      steps: ['Run a check now (seed below), rebuild, and run the same check again.'] };
  }
  return { level: 'warn', title: 'Maybe: try a rebuild',
    text: `Searches find ${pct(o)} of a full read's top 10 (below ${pct(d.min_overlap, 0)}), reading ${pct(d.read_share)} of the store. A better-fitted partition may recover some of it; a too-small probe budget looks the same, so measure.`,
    steps: [`Rebuild (below).`, `When it is done, run the recall check again with seed ${d.seed ?? '(same)'} and the same budget.`,
      'Keep the rebuild if overlap rose; if it did not, raise probe_budget_entries instead.'] };
}

// ── Decision sub-tab ─────────────────────────────────────────────────────────
function renderVopsDecision() {
  const p = vops.partition ?? {};
  const dec = vopsDecide();
  const levelCls = { good: 'vops-good', warn: 'vops-warn', info: 'vops-info', unknown: 'vops-unknown' }[dec.level];
  const settings = vopsSettings();
  const budget = effectiveBudget(settings, p.entries ?? 0);
  const latest = checks()[0];
  const atBudget = checks().find(c => c.data.budget_entries === budget);
  const whatIf = latest && latest !== atBudget ? latest : null;
  const shown = vops.lastCheck ?? latest?.data;
  const rb = p.rebuild;
  const seed = latest?.data?.seed ?? 24301; // the server's default seed (0x5eed)
  return `
    <div class="vops-decision ${levelCls}">
      <div class="vops-decision-title">${esc(dec.title)}</div>
      <div class="vops-decision-text">${esc(dec.text)}</div>
      ${dec.steps.length ? `<ol class="vops-steps">${dec.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
      <div class="vops-evidence">
        <span title="${esc(vt('read_share'))}">Budget ${fmt(budget)} of ${fmt(p.entries)} entries
          (${budget && p.entries ? pct(Math.min(1, budget / p.entries), 0) : '—'} of the store per search)</span>
        <span title="${esc(vt('overlap'))} Only checks at the store's own budget count here.">Last check at this budget: ${atBudget ? `${esc(atBudget.data.verdict)}, overlap@10 ${pct(ov10(atBudget.data))}, ${ago(atBudget.recorded_at_ms)}` : 'none'}</span>
        ${whatIf ? `<span title="A check run with a budget override: what searches would lose at that budget. It does not describe the store as configured.">Last what-if: budget ${fmt(whatIf.data.budget_entries)}, overlap@10 ${pct(ov10(whatIf.data))}, ${ago(whatIf.recorded_at_ms)}</span>` : ''}
        <span title="${esc(vt('rb_state'))}">Last rebuild: ${rebuildsDone()[0] ? ago(rebuildsDone()[0].recorded_at_ms) : 'none recorded'}</span>
      </div>
    </div>

    <div class="admin-grid">
      <div class="admin-card">
        <div class="admin-card-title" title="Searches sampled queries twice: with this store's probe budget, and reading every posting. No embedding calls. Costs about sample × (search + full read), one query at a time.">RUN A RECALL CHECK</div>
        <div class="vops-form">
          <label title="${esc(vt('sampled'))}">Queries <input id="vops-sample" type="number" min="1" max="${vops.server?.recall_check?.max_sample ?? 1000}" value="100"></label>
          <label title="${esc(vt('seed'))}">Seed <input id="vops-seed" type="number" min="0" value="${seed}"></label>
          <label title="${esc(vt('min_overlap'))}">Threshold <input id="vops-min-overlap" type="number" min="0" max="1" step="0.01" value="${vops.server?.recall_check?.default_min_overlap ?? 0.95}"></label>
          <label title="Check a different probe budget without changing the store (entries). Empty: the store's budget.">Budget override <input id="vops-budget" type="number" min="1" placeholder="${fmt(settings?.search?.probe_budget_entries)}"></label>
          <label title="${esc(vt('min_probes'))} Empty: the store's.">Min probes <input id="vops-minp" type="number" min="1" placeholder="${settings?.search?.min_probes ?? ''}"></label>
          <label title="${esc(vt('max_probes'))} Empty: the store's.">Max probes <input id="vops-maxp" type="number" min="1" placeholder="${settings?.search?.max_probes ?? ''}"></label>
        </div>
        <div class="text-muted vops-note">Estimated time: ${estimateCheckCost()}. Queries come from the query cache (real searches);
          with fewer than ${vops.server?.recall_check?.min_cached_queries ?? 20} cached, stored chunks are used, which are a weaker signal.</div>
        <button class="btn btn-accent" id="vops-check-btn" onclick="runVopsCheck()" ${vops.checking ? 'disabled' : ''}>
          ${vops.checking ? 'Checking…' : '▶ Run recall check'}</button>
      </div>

      <div class="admin-card">
        <div class="admin-card-title" title="Re-cluster the store's partition from its stored codes: k-means over every chunk, each moved to its nearest new posting. No embedding calls, no re-encoding. Searches and writes continue.">REBUILD THE PARTITION</div>
        <div class="text-muted vops-note">Fits new centres on everything stored now and moves every chunk once. Helps when searches read a
          small share of the store and the centres chosen one split at a time fit badly. It does <b>not</b> re-embed: it raises
          centre drift. To re-embed, use vector reindex-all (Admin → Index Management).</div>
        <div class="vops-form">
          <label title="${esc(vt('rb_requested'))}">Postings <input id="vops-rb-postings" type="number" min="1" placeholder="${fmt(p.postings)} (as now)"></label>
        </div>
        <button class="btn btn-danger" onclick="confirmVopsRebuild()" ${rb?.state === 'running' ? 'disabled' : ''}>
          ${rb?.state === 'running' ? 'Rebuild running…' : '⟲ Rebuild…'}</button>
        ${renderRebuildStatus(rb)}
      </div>
    </div>

    ${shown ? renderCheckResult(shown, `${vops.lastCheck ? 'Result of the check just run' : `Last recorded check (${ago(latest.recorded_at_ms)})`}${shown.budget_entries !== budget ? ` — what-if at budget ${fmt(shown.budget_entries)}` : ''}`) : ''}
  `;
}

function estimateCheckCost() {
  const lc = checks()[0]?.data;
  if (!lc) return 'unknown until the first check (300 queries took ~2 s on a 23k-chunk store, ~10 s on 173k)';
  const per = (lc.search_ms ?? 0) + (lc.full_read_ms ?? 0);
  return `about ${durMs(per * 100)} per 100 queries (from the last check)`;
}

function renderRebuildStatus(rb) {
  if (!rb) {
    const last = rebuildsDone()[0];
    return `<div class="text-muted vops-note" title="${esc(vt('rb_state'))}">No rebuild since the server started${last ? `; the last recorded one finished ${esc(ago(last.recorded_at_ms))} (see History)` : ''}.</div>`;
  }
  const r = rb.report ?? {};
  const stCls = rb.state === 'done' ? 'good' : rb.state === 'failed' ? 'bad' : 'warn';
  const took = rb.finished_at_ms ? fmtDuration(Math.round((rb.finished_at_ms - rb.started_at_ms) / 1000)) : '—';
  return `<div class="vops-subcard">
    ${vrow('State', esc(rb.state), stCls, vt('rb_state'))}
    ${vrow('Started', `${when(rb.started_at_ms)}`, '', 'When the last rebuild started.')}
    ${vrow('Finished', `${when(rb.finished_at_ms)} (${took})`, '', 'When it ended, and how long it took.')}
    ${vrow('Postings requested', rb.postings_requested == null ? 'as active' : fmt(rb.postings_requested), '', vt('rb_requested'))}
    ${rb.report ? `
      ${vrow('Postings before', fmt(r.postings_before), '', vt('rb_before'))}
      ${vrow('Postings fitted', fmt(r.postings_fitted), '', vt('rb_fitted'))}
      ${vrow('Postings after', fmt(r.postings_after), '', vt('rb_after'))}
      ${vrow('Chunks', fmt(r.chunks), '', vt('rb_chunks'))}
      ${vrow('k-means iterations', fmt(r.iterations), '', vt('rb_iterations'))}
      ${vrow('Chunks moved', fmt(r.chunks_moved), '', vt('rb_moved'))}` : ''}
    ${rb.error ? vrow('Error', esc(rb.error), 'bad', 'Why it failed.') : ''}
  </div>`;
}

function overlapBars(d) {
  return `<div class="vops-bars">${(d.overlap ?? []).map(o => {
    const v = o.mean ?? 0;
    const color = v >= (d.min_overlap ?? 0.95) ? 'var(--success)' : v >= 0.8 ? 'var(--warning)' : 'var(--error)';
    return `<div class="vops-bar" title="${esc(`Overlap@${o.k}: ${pct(v)} of a full read's top ${o.k} found by the normal search.`)}">
      <div class="vops-bar-label">@${o.k}</div>
      <div class="progress-wrap" style="height:10px"><div class="progress-bar" style="width:${Math.min(v * 100, 100)}%;background:${color}"></div></div>
      <div class="vops-bar-val">${pct(v)}</div></div>`;
  }).join('')}</div>`;
}

function renderCheckResult(d, title) {
  const vCls = d.verdict === 'below_target' ? 'warn' : d.verdict === 'empty' ? '' : 'good';
  return `<div class="admin-card vops-wide">
    <div class="admin-card-title" title="${esc(vt('overlap'))}">${esc(title.toUpperCase())}</div>
    <div class="vops-check-cols">
      <div>${overlapBars(d)}</div>
      <div>
        ${vrow('Verdict', esc(d.verdict), vCls, vt('verdict'))}
        ${vrow('Query source', esc(d.query_source ?? '—'), d.query_source === 'stored_chunks' ? 'warn' : '', vt('query_source'))}
        ${vrow('Seed', d.seed ?? '—', '', vt('seed'))}
        ${vrow('Queries', fmt(d.sampled), '', vt('sampled'))}
        ${vrow('Threshold', pct(d.min_overlap, 0), '', vt('min_overlap'))}
        ${vrow('Overlap@10, worst tenth', pct(d.overlap_at_10_p10, 0), '', vt('overlap_p10'))}
        ${vrow('Probe budget', fmt(d.budget_entries), '', vt('budget'))}
        ${vrow('Read per search', pct(d.read_share), '', vt('read_share'))}
        ${vrow('Postings probed', d.probes_mean?.toFixed(1) ?? '—', '', vt('probes_mean'))}
        ${vrow('Store', `${fmt(d.entries)} entries, ${fmt(d.postings)} postings`, '', 'The store when the check ran.')}
        ${vrow('Reference is a full read', d.reference_is_full_read ? 'yes' : 'no (capped)', d.reference_is_full_read ? '' : 'warn', vt('reference_full'))}
        ${vrow('Reference read', pct(d.reference_share), '', vt('reference_share'))}
        ${vrow('Search / full read', `${durMs(d.search_ms)} / ${durMs(d.full_read_ms)}`, '', `${vt('search_ms')} ${vt('full_read_ms')}`)}
        ${vrow('Check took', durMs(d.elapsed_ms), '', vt('elapsed_ms'))}
      </div>
    </div>
  </div>`;
}

async function runVopsCheck() {
  const v = (id) => document.getElementById(id)?.value?.trim();
  vops.checking = true;
  renderVopsBody();
  try {
    const opts = { sample: v('vops-sample'), seed: v('vops-seed'), min_overlap: v('vops-min-overlap'),
      probe_budget_entries: v('vops-budget'), min_probes: v('vops-minp'), max_probes: v('vops-maxp') };
    const ns = vops.ns;
    vops._form = opts;
    const r = await Api.vectorRecallCheck(ns, opts);
    if (ns !== vops.ns) return;
    vops.lastCheck = r;
    toast(`Recall check: ${r.verdict}, overlap@10 ${pct(ov10(r))}`);
    const h = await Api.vectorHistory(ns, null, 1000);
    vops.history = h.records ?? [];
  } catch (e) {
    toast(`Recall check failed: ${e.message}`, 'error', 6000);
  } finally {
    vops.checking = false;
    renderVopsBody();
    restoreVopsForm();
  }
}

function restoreVopsForm() {
  const f = vops._form;
  if (!f) return;
  const set = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
  set('vops-sample', f.sample); set('vops-seed', f.seed); set('vops-min-overlap', f.min_overlap);
  set('vops-budget', f.probe_budget_entries); set('vops-minp', f.min_probes); set('vops-maxp', f.max_probes);
}

function confirmVopsRebuild() {
  const p = vops.partition ?? {};
  const want = document.getElementById('vops-rb-postings')?.value?.trim();
  const lc = checks()[0];
  openModal(`
    <h3 style="margin-bottom:12px">Rebuild the partition of ${esc(vops.ns)}?</h3>
    <ul class="vops-modal-list">
      <li>k-means fits ${want ? fmt(Number(want)) : `${fmt(p.postings)} (as now)`} postings on all ${fmt(p.chunks)} stored chunks, then every chunk moves to its nearest new posting.</li>
      <li>No embedding calls and no re-encoding: centre drift will <b>rise</b>.</li>
      <li>Searches and writes continue. Measured: about 7 s for 23k chunks, 150 s for 173k, on 2 threads.</li>
      <li>${lc ? `Your last recall check used seed ${lc.data.seed ?? '—'} and budget ${fmt(lc.data.budget_entries)}: run it again with the same values afterwards to see what the rebuild gained.`
              : 'Run a recall check first, so you can compare before and after.'}</li>
    </ul>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="doVopsRebuild(${want ? Number(want) : 'null'})">⟲ Rebuild</button>
    </div>`);
}

async function doVopsRebuild(postings) {
  closeModal();
  try {
    await Api.vectorRebuild(vops.ns, postings);
    toast('Rebuild started');
    await loadVectorOps();
    startRebuildPoll();
  } catch (e) {
    toast(`Rebuild refused: ${e.message}`, 'error', 6000);
  }
}

function startRebuildPoll() {
  if (vops.rebuildPoll) return;
  vops.rebuildPoll = setInterval(async () => {
    try {
      const p = await Api.vectorPartition(vops.ns, false);
      vops.partition = p;
      if (p.rebuild?.state !== 'running') {
        clearInterval(vops.rebuildPoll);
        vops.rebuildPoll = null;
        toast(`Rebuild ${p.rebuild?.state}`, p.rebuild?.state === 'done' ? 'success' : 'error');
        const h = await Api.vectorHistory(vops.ns, null, 1000);
        vops.history = h.records ?? [];
        vops.allPostings = null;
      }
      if (state.activeTab === 'admin' && state.adminTab === 'vector-ops') renderVopsBody();
    } catch { /* keep polling */ }
  }, 2000);
}

// ── Partition sub-tab ────────────────────────────────────────────────────────
async function loadVopsAllPostings() {
  try {
    const r = await Api.vectorPostings(vops.ns, { limit: 10000, sort: 'chunks', order: 'desc' });
    vops.allPostings = r.results ?? [];
    if (vops.sub === 'partition') renderVopsBody();
  } catch { vops.allPostings = []; }
}

function sizeHistogram(p) {
  const live = (vops.allPostings ?? []).filter(x => x.state !== 'retired');
  if (!live.length) return '<div class="text-muted vops-note">Loading posting sizes…</div>';
  const split = p.split_limit ?? 0, merge = p.merge_limit ?? 0;
  const max = Math.max(split + 1, ...live.map(x => x.chunks));
  const nb = 24, w = Math.ceil((max + 1) / nb);
  const bins = Array(nb).fill(0);
  live.forEach(x => { bins[Math.min(nb - 1, Math.floor(x.chunks / w))]++; });
  const top = Math.max(...bins, 1);
  const mark = (v, label, cls) => `<div class="vops-hist-mark ${cls}" style="left:${(v / (nb * w)) * 100}%" title="${esc(label)}"><span>${esc(label)}</span></div>`;
  return `<div class="vops-hist" title="Live postings by size (chunks). Most should sit between the merge and split limits.">
    ${bins.map((b, i) => `<div class="vops-hist-bar" style="height:${(b / top) * 100}%" title="${i * w}–${(i + 1) * w - 1} chunks: ${b} posting(s)"></div>`).join('')}
    ${mark(merge, `merge ≤ ${merge}`, 'merge')}${mark(p.target_posting_size ?? 0, `target ${p.target_posting_size}`, 'target')}${mark(split, `split > ${split}`, 'split')}
  </div><div class="vops-hist-axis"><span>0</span><span>${fmt(nb * w)} chunks</span></div>`;
}

function renderVopsPartition() {
  const p = vops.partition;
  if (!p) return '<div class="spinner"></div>';
  const m = p.maintenance ?? {};
  const [p10, p50, p90, pmax] = p.size_p10_p50_p90_max ?? [];
  const c = vops.corruption ?? {};
  const moves = (m.reassign_moves ?? 0) + (m.drain_moves ?? 0);
  return `
    <div class="text-muted vops-note">From memory: cheap to refresh. Maintenance counters count since the partition loaded (server start or the store's first use).</div>
    <div class="admin-grid">
      <div class="admin-card">
        <div class="admin-card-title" title="How the store's vectors are partitioned into postings (IVF clusters).">SIZE AND SHAPE</div>
        ${vrow('Postings (K)', fmt(p.postings), '', vt('postings'))}
        ${vrow('Retired postings', fmt(p.retired), '', vt('retired'))}
        ${vrow('Centres', fmt(p.centres), '', vt('centres'))}
        ${vrow('Entries', fmt(p.entries), '', vt('entries'))}
        ${vrow('Chunks', fmt(p.chunks), '', vt('chunks'))}
        ${vrow('Chunks per posting p10 / p50 / p90', `${fmt(p10)} / ${fmt(p50)} / ${fmt(p90)}`, '', vt('sizes'))}
        ${vrow('Largest posting', fmt(pmax), pmax > (p.split_limit ?? Infinity) ? 'warn' : '', `${vt('sizes')} Above the split limit means a split is pending or was refused (a split whose smaller half would merge straight back is refused).`)}
        ${vrow('Target posting size', fmt(p.target_posting_size), '', vt('target'))}
        ${vrow('Split limit', `> ${fmt(p.split_limit)}`, '', vt('split_limit'))}
        ${vrow('Merge limit', `≤ ${fmt(p.merge_limit)}`, '', vt('merge_limit'))}
        ${vrow('Splits (all time)', fmt(p.splits), '', vt('splits_total'))}
      </div>
      <div class="admin-card">
        <div class="admin-card-title" title="What partition maintenance did since the partition loaded. In-memory, reset on restart.">MAINTENANCE SINCE LOAD</div>
        ${vrow('Splits', fmt(m.splits), '', vt('m_splits'))}
        ${vrow('Merges', fmt(m.merges), '', vt('m_merges'))}
        ${vrow('Reassignment passes', fmt(m.reassigns), '', vt('m_reassigns'))}
        ${vrow('Reassign candidates', fmt(m.reassign_candidates), '', vt('m_reassign_candidates'))}
        ${vrow('Reassign moves', fmt(m.reassign_moves), '', vt('m_reassign_moves'))}
        ${vrow('Drain moves', fmt(m.drain_moves), '', vt('m_drain_moves'))}
        ${vrow('Chunk moves (maintenance)', fmt(moves), '', vt('m_moves_total'))}
        ${vrow('Rebuilds', fmt(m.rebuilds), '', vt('m_rebuilds'))}
        ${vrow('Rebuild moves', fmt(m.rebuild_moves), '', vt('m_rebuild_moves'))}
      </div>
      <div class="admin-card">
        <div class="admin-card-title" title="Signs that something needs attention.">HEALTH</div>
        ${vrow('Unfinished operations', fmt(p.unfinished_operations), (p.unfinished_operations ?? 0) > 0 ? 'warn' : 'good', vt('unfinished'))}
        ${vrow('Corrupt Pass-1 entries skipped', fmt(c.sparse_corrupt_skipped), (c.sparse_corrupt_skipped ?? 0) > 0 ? 'bad' : 'good', vt('c_sparse'))}
        ${vrow('Corrupt Pass-2 entries skipped', fmt(c.dense_corrupt_skipped), (c.dense_corrupt_skipped ?? 0) > 0 ? 'bad' : 'good', vt('c_dense'))}
        ${vrow('Corrupt entries, total', fmt(c.total_corrupt_skipped), (c.total_corrupt_skipped ?? 0) > 0 ? 'bad' : 'good', vt('c_total'))}
      </div>
      <div class="admin-card">
        <div class="admin-card-title" title="${esc(vt('rb_state'))}">LAST REBUILD (SINCE SERVER START)</div>
        ${renderRebuildStatus(p.rebuild)}
      </div>
    </div>
    <div class="admin-card vops-wide">
      <div class="admin-card-title" title="Every live posting by size, with the merge limit, target and split limit marked.">POSTING SIZE DISTRIBUTION</div>
      ${sizeHistogram(p)}
    </div>`;
}

// ── Code metrics sub-tab ─────────────────────────────────────────────────────
function renderVopsCodes() {
  const recs = codeRecords();
  const latest = recs[0];
  const c = latest?.data?.codes;
  const cand = latest?.data?.reencode_candidates ?? [];
  return `
    <div class="admin-card vops-wide vops-explain">
      <div class="admin-card-title">WHAT THESE MEASURE, AND WHAT THEY DO NOT</div>
      <p>Every chunk is stored as a 1-bit <b>code</b>: its direction relative to a <b>centre</b>, the centre of the posting it was
        written into. When maintenance (a split, merge or rebuild) moves a chunk to another posting, the code is <b>not</b>
        re-encoded: it keeps its own centre, and search scores it against that centre, so results stay correct. What changes is
        precision: a code encoded against a centre far from where it now sits is a coarser approximation.</p>
      <ul>
        <li><b>Centre drift</b> measures that distance (0 = at home). It is a signal for <b>re-embedding</b> (vector reindex-all,
          which encodes every chunk against its current posting), never for a rebuild.</li>
        <li><b>A rebuild raises drift</b>: it moves every chunk without re-encoding (measured 0.28–0.40 before, 0.45–0.51 after).
          A rebuild improves which posting a chunk is in, i.e. recall at small read shares; the recall check measures that.</li>
        <li>So far drift has cost no measurable ranking (simulated). These numbers are here to watch, not to act on by threshold.</li>
      </ul>
      <p class="text-muted">Computing them reads every chunk code of the store (seconds on large stores). Each computation is
        recorded in the history, so the latest values below need no recomputation.</p>
      <button class="btn btn-accent" onclick="computeVopsCodes()" ${vops.computingCodes ? 'disabled' : ''}>
        ${vops.computingCodes ? 'Reading codes…' : '▶ Compute code metrics now'}</button>
    </div>
    ${c ? `
    <div class="admin-grid">
      <div class="admin-card">
        <div class="admin-card-title" title="Entry-weighted means over the store's live postings.">CODE METRICS (${esc(ago(latest.recorded_at_ms))})</div>
        ${vrow('Centre drift, mean', num3(c.drift_mean), '', vt('drift_mean'))}
        ${vrow('Centre drift, p90', num3(c.drift_p90), '', vt('drift_p90'))}
        ${vrow('Foreign share', pct(c.foreign_share), '', vt('foreign'))}
        ${vrow('Zero-centre share', pct(c.zero_centre_share), '', vt('zero_centre'))}
        ${vrow('Error band, mean', num3(c.error_band_mean), '', vt('error_band'))}
        ${vrow('Recorded', when(latest.recorded_at_ms), '', 'When these were computed.')}
      </div>
      <div class="admin-card">
        <div class="admin-card-title" title="${esc(vt('reencode'))}">RE-ENCODE CANDIDATES</div>
        <div class="text-muted vops-note">${esc(vt('reencode'))}</div>
        <div class="vops-chips">${cand.length ? cand.map(id => `<span class="vops-chip" title="Posting ${id}">${id}</span>`).join('') : '—'}</div>
        <button class="btn btn-secondary btn-sm" onclick="vops.postings={...vops.postings,sort:'drift',order:'desc',codes:true,stack:[null],idx:0,data:null};switchVopsTab('postings')">
          Show postings by drift</button>
      </div>
    </div>` : '<div class="text-muted vops-note">Not computed yet for this store.</div>'}
    ${recs.length > 1 ? `
    <div class="admin-card vops-wide">
      <div class="admin-card-title" title="Every recorded code-metrics computation, newest first. A rebuild shows as a jump in drift and foreign share.">TREND</div>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th title="When the code metrics were computed (your local time).">When</th><th title="${esc(vt('drift_mean'))}">Drift mean</th><th title="${esc(vt('drift_p90'))}">Drift p90</th>
          <th title="${esc(vt('foreign'))}">Foreign</th><th title="${esc(vt('zero_centre'))}">Zero-centre</th><th title="${esc(vt('error_band'))}">Error band</th>
          <th title="${esc(vt('postings'))}">Postings</th><th title="${esc(vt('chunks'))}">Chunks</th></tr></thead>
        <tbody>${recs.map(r => { const k = r.data.codes ?? {}; return `<tr><td>${when(r.recorded_at_ms)}</td><td>${num3(k.drift_mean)}</td>
          <td>${num3(k.drift_p90)}</td><td>${pct(k.foreign_share)}</td><td>${pct(k.zero_centre_share)}</td><td>${num3(k.error_band_mean)}</td>
          <td>${fmt(r.data.postings)}</td><td>${fmt(r.data.chunks)}</td></tr>`; }).join('')}</tbody>
      </table></div>
    </div>` : ''}`;
}

async function computeVopsCodes() {
  vops.computingCodes = true;
  renderVopsBody();
  try {
    const ns = vops.ns;
    await Api.vectorPartition(ns, true);
    const h = await Api.vectorHistory(ns, null, 1000);
    if (ns === vops.ns) vops.history = h.records ?? [];
    toast('Code metrics computed');
  } catch (e) {
    toast(`Code metrics failed: ${e.message}`, 'error', 6000);
  } finally {
    vops.computingCodes = false;
    renderVopsBody();
  }
}

// ── Postings sub-tab ─────────────────────────────────────────────────────────
async function loadVopsPostings() {
  const st = vops.postings;
  try {
    const r = await Api.vectorPostings(vops.ns, { sort: st.sort, order: st.order, codes: st.codes, limit: st.limit, cursor: st.stack[st.idx] });
    st.data = r;
    st.next = r.next_cursor ?? null;
    if (st.codes || st.sort === 'drift') {
      const h = await Api.vectorHistory(vops.ns, null, 1000);
      vops.history = h.records ?? [];
    }
  } catch (e) {
    st.data = { error: e.message };
  }
  if (vops.sub === 'postings') renderVopsBody();
}

function setVopsPostings(changes) {
  Object.assign(vops.postings, changes, { stack: [null], idx: 0, data: null });
  renderVopsBody();
  loadVopsPostings();
}
function vopsPostingsPage(dir) {
  const st = vops.postings;
  if (dir > 0 && st.next) { st.stack = st.stack.slice(0, st.idx + 1); st.stack.push(st.next); st.idx++; }
  if (dir < 0 && st.idx > 0) st.idx--;
  st.data = null;
  renderVopsBody();
  loadVopsPostings();
}

function renderVopsPostings() {
  const st = vops.postings;
  const d = st.data;
  const codes = st.codes || st.sort === 'drift';
  const split = vops.partition?.split_limit ?? 0;
  const head = `
    <div class="vops-form vops-postings-ctl">
      <label title="Order of the rows.">Sort <select onchange="setVopsPostings({sort:this.value})">
        ${['id', 'entries', 'chunks', 'drift'].map(s => `<option ${s === st.sort ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <label>Order <select onchange="setVopsPostings({order:this.value})">
        ${['asc', 'desc'].map(s => `<option ${s === st.order ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <label title="Rows per page (at most 10,000).">Rows <input type="number" min="1" max="10000" value="${st.limit}" onchange="setVopsPostings({limit:this.value})"></label>
      <label title="Add each posting's code metrics. Reads every chunk code of the store (costly on large stores); sorting by drift implies it."><input type="checkbox" ${codes ? 'checked' : ''} onchange="setVopsPostings({codes:this.checked})"> Code metrics</label>
    </div>`;
  if (!d) return head + '<div class="spinner"></div>';
  if (d.error) return head + `<div class="alert alert-error">${esc(d.error)}</div>`;
  const rows = d.results ?? [];
  return head + `
    <div class="text-muted vops-note">${fmt(d.postings)} live postings, ${fmt(d.entries)} entries, ${fmt(d.chunks)} chunks. Retired postings are listed as the parents of the split/merge tree; they hold nothing.</div>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr>
        <th title="The posting's id (its key prefix).">Posting</th>
        <th title="active: searched and written to. draining: being emptied by a split, merge or rebuild. retired: empty record.">State</th>
        <th title="The centre new codes in this posting are encoded against.">Centre</th>
        <th title="The posting it was split from or merged out of.">Parent</th>
        <th title="root (the first posting), split, rebuild, or seed (a store created before partitions grew by themselves).">Created by</th>
        <th title="${esc(vt('entries'))}">Entries</th>
        <th title="${esc(vt('chunks'))}">Chunks</th>
        <th title="Chunks against the split limit (full bar = at the split limit).">Size</th>
        ${codes ? `<th title="${esc(vt('foreign'))}">Foreign</th><th title="${esc(vt('zero_centre'))}">Zero-centre</th>
          <th title="${esc(vt('drift_mean'))}">Drift mean</th><th title="${esc(vt('drift_p90'))}">Drift p90</th><th title="${esc(vt('error_band'))}">Error band</th>` : ''}
      </tr></thead>
      <tbody>${rows.map(r => {
        const k = r.codes ?? {};
        const fill = split ? Math.min(r.chunks / split, 1) : 0;
        return `<tr class="${r.state === 'retired' ? 'text-muted' : ''}">
          <td>${r.posting_id}</td><td>${esc(r.state)}</td><td>${r.centre_id}</td><td>${r.parent_id ?? '—'}</td><td>${esc(r.created_by)}</td>
          <td>${fmt(r.entries)}</td><td>${fmt(r.chunks)}</td>
          <td style="min-width:90px"><div class="progress-wrap" style="height:8px"><div class="progress-bar" style="width:${fill * 100}%;background:${r.chunks > split ? 'var(--warning)' : 'var(--accent)'}"></div></div></td>
          ${codes ? `<td>${pct(k.foreign_share, 0)}</td><td>${pct(k.zero_centre_share, 0)}</td><td>${num3(k.drift_mean)}</td><td>${num3(k.drift_p90)}</td><td>${num3(k.error_band_mean)}</td>` : ''}
        </tr>`; }).join('')}</tbody>
    </table></div>
    <div class="vops-pager">
      <button class="btn btn-secondary btn-sm" onclick="vopsPostingsPage(-1)" ${st.idx === 0 ? 'disabled' : ''}>← Prev</button>
      <span class="text-muted">Page ${st.idx + 1}</span>
      <button class="btn btn-secondary btn-sm" onclick="vopsPostingsPage(1)" ${st.next ? '' : 'disabled'}>Next →</button>
    </div>`;
}

// ── History sub-tab ──────────────────────────────────────────────────────────
function renderVopsHistory() {
  const ttl = vops.historyTtl;
  const timeline = vops.history.filter(r => r.kind === 'recall_check' || r.kind === 'rebuild');
  const codesN = codeRecords().length;
  const cs = checks();
  const deltaFor = (r) => {
    // Overlap@10 change against the previous comparable check (same seed, source, budget).
    const i = cs.indexOf(r);
    const prev = cs.slice(i + 1).find(c => sameCheck(c.data, r.data));
    if (!prev) return '';
    const dl = (ov10(r.data) - ov10(prev.data)) * 100;
    return `<span class="${dl >= 1 ? 'vops-up' : dl <= -1 ? 'vops-down' : 'text-muted'}" title="Change in overlap@10 against the previous check with the same seed, query source and budget.">${dl >= 0 ? '+' : ''}${dl.toFixed(1)}</span>`;
  };
  return `
    <div class="text-muted vops-note">Recorded recall checks and rebuilds, newest first. Records are kept ${ttl ? fmtDuration(ttl) : '30 days'}
      (server setting partition_history_ttl_secs) and written only when someone runs a check, a code-metrics read or a rebuild.
      Code-metrics records (${codesN}) are on the Code metrics tab.</div>
    ${timeline.length ? `<div class="tbl-wrap"><table class="tbl vops-history">
      <thead><tr>
        <th title="When the check ran or the rebuild finished (your local time).">When</th><th title="A recall check, or a rebuild (its row summarises what it did).">Event</th>
        <th title="${esc(vt('verdict'))}">Verdict</th>
        ${[10, 20, 30, 40, 50, 100].map(k => `<th title="${esc(`Overlap@${k}: of the top ${k} a full read returns, the share the normal search also returned. ${vt('overlap')}`)}">@${k}</th>`).join('')}
        <th title="Change in overlap@10 against the previous check with the same seed, query source and budget: what changed in between (e.g. a rebuild) gained or lost.">Δ@10</th>
        <th title="${esc(vt('overlap_p10'))}">p10@10</th>
        <th title="${esc(vt('query_source'))}">Source</th>
        <th title="${esc(vt('seed'))}">Seed</th>
        <th title="${esc(vt('sampled'))}">Queries</th>
        <th title="${esc(vt('budget'))}">Budget</th>
        <th title="${esc(vt('read_share'))}">Read</th>
        <th title="${esc(vt('reference_full'))}">Ref</th>
        <th title="${esc(vt('elapsed_ms'))}">Took</th>
      </tr></thead>
      <tbody>${timeline.map(r => {
        if (r.kind === 'rebuild') {
          const d = r.data, rp = d.report ?? {};
          return `<tr class="vops-rebuild-row"><td>${when(r.recorded_at_ms)}</td><td>⟲ Rebuild ${esc(d.state)}</td>
            <td colspan="16">${d.report ? `${fmt(rp.postings_before)} → ${fmt(rp.postings_fitted)} fitted → ${fmt(rp.postings_after)} postings;
              ${fmt(rp.chunks_moved)} of ${fmt(rp.chunks)} chunks moved; ${fmt(rp.iterations)} k-means iterations;
              took ${d.finished_at_ms ? fmtDuration(Math.round((d.finished_at_ms - d.started_at_ms) / 1000)) : '—'}` : esc(d.error ?? '')}</td></tr>`;
        }
        const d = r.data;
        const o = (k) => pct(d.overlap?.find(x => x.k === k)?.mean);
        const vCls = d.verdict === 'below_target' ? 'vops-warn-text' : d.verdict === 'empty' ? '' : 'vops-good-text';
        return `<tr><td>${when(r.recorded_at_ms)}</td><td>Recall check</td><td class="${vCls}">${esc(d.verdict)}</td>
          <td><b>${o(10)}</b></td><td>${o(20)}</td><td>${o(30)}</td><td>${o(40)}</td><td>${o(50)}</td><td>${o(100)}</td>
          <td>${deltaFor(r)}</td><td>${pct(d.overlap_at_10_p10, 0)}</td>
          <td class="${d.query_source === 'stored_chunks' ? 'vops-warn-text' : ''}">${esc(d.query_source === 'cached_queries' ? 'queries' : d.query_source === 'stored_chunks' ? 'chunks' : '—')}</td>
          <td>${d.seed ?? '—'}</td><td>${fmt(d.sampled)}</td><td>${fmt(d.budget_entries)}</td><td>${pct(d.read_share, 0)}</td>
          <td>${d.reference_is_full_read ? 'full' : 'capped'}</td><td>${durMs(d.elapsed_ms)}</td></tr>`;
      }).join('')}</tbody>
    </table></div>` : '<div class="text-muted vops-note">No recall checks or rebuilds recorded yet.</div>'}`;
}

// ── Settings sub-tab ─────────────────────────────────────────────────────────
function renderVopsSettings() {
  const s = vopsSettings();
  const srv = vops.server;
  const p = vops.partition ?? {};
  const def = srv?.namespace_defaults ?? {};
  if (!s) return '<div class="text-muted">This store has no vector-index settings.</div>';
  const fmtV = (v) => (v == null ? '—' : typeof v === 'boolean' ? (v ? 'on' : 'off') : typeof v === 'number' ? (Number.isInteger(v) ? fmt(v) : String(+v.toFixed(4))) : esc(String(v)));
  const row = (key, val, dflt, fixed) => {
    const differs = dflt !== undefined && dflt !== null && String(val) !== String(dflt);
    return `<tr><td title="${esc(vt(key))}"><span class="stat-key" title="${esc(vt(key))}">${key}</span></td>
      <td class="${differs ? 'vops-differs' : ''}"><b>${fmtV(val)}</b></td><td>${dflt === undefined ? '' : fmtV(dflt)}</td>
      <td>${fixed}</td><td class="text-muted">${esc(vt(key))}</td></tr>`;
  };
  const group = (title, rows) => `<tr class="vops-group"><td colspan="5">${title}</td></tr>${rows.join('')}`;
  const q = s.quantisation ?? {}, ch = s.chunking ?? {}, se = s.search ?? {}, mt = s.maintenance ?? {};
  const ds = def.search ?? {}, dm = def.maintenance ?? {};
  const srvRow = (key, val) => vrow(key, fmtV(val), '', vt(key));
  return `
    <div class="admin-card vops-wide">
      <div class="admin-card-title" title="This store's own vector-index settings (its schema's vector_index). Values that differ from the server default for new stores are highlighted.">THIS STORE: ${esc(vops.ns)}</div>
      <div class="tbl-wrap"><table class="tbl vops-settings">
        <thead><tr><th title="The setting's name in the store's schema (vector_index).">Setting</th><th title="This store's value. Highlighted where it differs from the server default.">This store</th><th title="What the server gives a store when it enables semantic search ([semantic_search] defaults).">Server default</th><th title="fixed: set once for the store's life. read-only: chosen by minnal. yes: change with the update_vector_search schema amendment; per request: overridable on one search or check.">Can change?</th><th title="What the setting does.">Meaning</th></tr></thead>
        <tbody>
          ${group('Embedding and chunking', [
            row('embedding_model', s.embedding_model, undefined, 'fixed'),
            row('embedding_dim', s.embedding_dim, undefined, 'fixed'),
            row('window_size', ch.window_size, undefined, 'fixed'),
            row('sliding_size', ch.sliding_size, undefined, 'fixed')])}
          ${group('Quantisation', [
            row('pass1_bits', q.pass1_bits, undefined, 'read-only'),
            row('pass2_bits', q.pass2_bits, undefined, 'read-only'),
            row('pass2_centre', q.pass2_centre, undefined, 'read-only'),
            row('rotation_seed', q.rotation_seed, undefined, 'read-only')])}
          ${group('Search', [
            row('probe_budget_entries', se.probe_budget_entries, ds.probe_budget_entries, 'yes; per request'),
            row('min_probes', se.min_probes, ds.min_probes, 'yes; per request'),
            row('max_probes', se.max_probes, ds.max_probes, 'yes; per request'),
            row('first_pass_top_k', se.first_pass_top_k, ds.first_pass_top_k, 'yes; per request'),
            row('top_k', se.top_k, ds.top_k, 'yes; per request'),
            row('probe_budget_fraction', se.probe_budget_fraction, ds.probe_budget_fraction ?? 0, 'yes'),
            row('probe_budget_floor', se.probe_budget_floor, ds.probe_budget_floor, 'yes')])}
          ${group('Partition maintenance', [
            row('target_posting_size', mt.target_posting_size, dm.target_posting_size, 'yes'),
            row('split_limit', p.split_limit, dm.split_limit, 'derived (2 × target)'),
            row('merge_limit', p.merge_limit, dm.merge_limit, 'derived'),
            row('reassign_range', mt.reassign_range, dm.reassign_range, 'yes'),
            row('merge_ratio', mt.merge_ratio, dm.merge_ratio, 'yes'),
            row('skip_uncertain_moves', mt.skip_uncertain_moves, dm.skip_uncertain_moves, 'yes'),
            row('split_samples', mt.split_samples, dm.split_samples, 'yes'),
            row('split_init_trials', mt.split_init_trials, dm.split_init_trials, 'yes'),
            row('split_max_iters', mt.split_max_iters, dm.split_max_iters, 'yes'),
            row('split_lambda_factor', mt.split_lambda_factor, dm.split_lambda_factor, 'yes')])}
          ${group('Derived now', [
            row('effective_probe_budget', effectiveBudget(s, p.entries ?? 0), undefined, 'derived')])}
        </tbody>
      </table></div>
    </div>
    <div class="admin-card vops-wide">
      <div class="admin-card-title" title="The server's [semantic_search] settings. They apply to every store; change them in the server's config file and restart.">SERVER-WIDE (ALL STORES)</div>
      ${srv ? `<div class="admin-grid" style="margin-bottom:0">
        <div>
          ${srvRow('embedding_service_url', srv.embedding_service_url)}
          ${vrow('supported_models', Object.keys(srv.supported_models ?? {}).length ? esc(Object.entries(srv.supported_models).map(([k, v]) => `${k} (${v})`).join(', ')) : 'any the service serves', '', vt('supported_models'))}
          ${srvRow('embedding_request_timeout_secs', srv.embedding_request_timeout_secs)}
          ${srvRow('embedding_connect_timeout_secs', srv.embedding_connect_timeout_secs)}
          ${srvRow('query_embedding_cache_ttl_secs', srv.query_embedding_cache_ttl_secs)}
          ${srvRow('partition_history_ttl_secs', srv.partition_history_ttl_secs)}
        </div>
        <div>
          ${srvRow('maintenance_threads', srv.maintenance_threads)}
          ${srvRow('rebuild_threads', srv.rebuild_threads)}
          ${srvRow('max_rebuild_threads', srv.max_rebuild_threads)}
          ${srvRow('max_sample', srv.recall_check?.max_sample)}
          ${srvRow('min_cached_queries', srv.recall_check?.min_cached_queries)}
          ${srvRow('max_reference_entries', srv.recall_check?.max_reference_entries)}
          ${srvRow('default_min_overlap', srv.recall_check?.default_min_overlap)}
        </div>
      </div>` : '<div class="text-muted">Server settings unavailable (needs a minnal server with GET /admin/indices/vector/settings).</div>'}
    </div>`;
}
