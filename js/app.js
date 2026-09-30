/**
 * app.js — application state, rendering, and event handling.
 */

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  baseUrl:           'http://localhost:8080',
  stores:            [],   // DocStoreSchema[]
  kvStores:          [],   // KvStoreSchema[]
  selectedStore:     null, // DocStoreSchema | KvStoreSchema | null
  selectedStoreType: null, // 'doc' | 'kv' | null
  activeTab:         'schema',

  // Documents / KV sub-tab
  docSubTab:      'get',
  docResult:      null,
  docList:        [],

  // Query sub-tab
  querySubTab:    'predicate',
  queryResults:   [],

  // Admin cached data
  adminStats:     null,
  adminWal:       null,
  adminLsm:       null,
  adminVlog:      null,
  adminTab:       'storage', // 'storage' | 'ops' | 'index'
  adminSys:       null, // /admin/system-stores payload cached during loadStorageStats
  adminRowCounts: {}, // { [namespace]: number }
  storageStoresTab:  'doc', // 'doc' | 'kv' | 'system' — active tab in the namespaces section
  storageSelectedNs: { doc: null, kv: null, system: null }, // selected namespace per tab
  opsByNamespace: [],   // NamespaceOpsMetrics[] cached from the by-namespace endpoint
  opsSelectedNs:  null, // namespace selected in the per-namespace ops panel

  // Progress polling: { 'ns::field': intervalId }
  progressPolls: {},

  // Last semantic search results (for popup callback)
  _semanticResults: [],

  // Last doc list results (range / query / get — for popup callback)
  _docResults: [],

  // Gap records from the last field-index health load (for the Gap… popup)
  _healthGaps: [],

  // Create-store field rows counter (for unique IDs)
  fieldRowSeq: 0,

  // Cursor-based scan pagination state
  scanCursors: {},   // { [scanId]: { stack: [null, ...], idx: 0 } }
  _nextCursors: {},  // { [scanId]: nextCursor } — written by renderCursorNav, read by scanNext
};

// ── Utilities ─────────────────────────────────────────────────────────────────
function fmt(n) { return n?.toLocaleString() ?? '—'; }
function fmtBytes(b) {
  if (b == null) return '—';
  if (b < 1024)          return b + ' B';
  if (b < 1024 * 1024)   return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 ** 3)     return (b / 1024 / 1024).toFixed(2) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function fmtUptime(s) {
  if (!s && s !== 0) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function keyTypeBadge(kt) {
  return `<span class="badge badge-${kt}">${kt}</span>`;
}

/** minnal_db's MAX_STR_KEY_LEN — the cap on str keys in both doc and KV stores. */
const MAX_STR_KEY_LEN = 50;

/** Byte length of a string as the server sees it: the cap counts UTF-8 bytes, not chars. */
function utf8Len(s) {
  return new TextEncoder().encode(s).length;
}

/**
 * Validate a str key for `store` before it reaches the server, so an over-long
 * key fails here instead of after a round trip. Returns an error message, or
 * null when the key is fine or the store is not string-keyed.
 */
function strKeyIssue(store, key) {
  if (store?.key_type !== 'str') return null;
  const len = utf8Len(key);
  if (len === 0) return 'Key must not be empty';
  if (len > MAX_STR_KEY_LEN) {
    return `Key is ${len} UTF-8 bytes — the limit is ${MAX_STR_KEY_LEN}`;
  }
  return null;
}

/**
 * Same cap, applied to a scan prefix: no key can be longer than
 * MAX_STR_KEY_LEN, so a longer prefix matches nothing.
 */
function strPrefixIssue(store, prefix) {
  if (store?.key_type !== 'str') return null;
  const len = utf8Len(prefix);
  if (len > MAX_STR_KEY_LEN) {
    return `Prefix is ${len} UTF-8 bytes — keys are capped at ${MAX_STR_KEY_LEN}, so it cannot match anything`;
  }
  return null;
}

/** Placeholder for a single document ID input, in the store's key format. */
function docIdPlaceholder(s, short) {
  switch (s.key_type) {
    case 'uuid': return short ? 'e.g. 550e8400-...' : 'e.g. 550e8400-e29b-41d4-a716-446655440000';
    case 'str':  return `e.g. acme-corp (1–${MAX_STR_KEY_LEN} UTF-8 bytes)`;
    default:     return 'e.g. 42';
  }
}

/** Placeholder for the inclusive start bound of a document range scan. */
function docRangeStartPlaceholder(s) {
  switch (s.key_type) {
    case 'uuid': return '00000000-0000-...';
    case 'str':  return 'e.g. acme-';
    default:     return '0';
  }
}

function idxTypeBadge(it) {
  return `<span class="badge badge-${it}">${it}</span>`;
}
function kvValueTypeBadge(vt) {
  const cls = vt === 'vec_f32' ? 'badge-vec_f32' : `badge-${vt}`;
  return `<span class="badge ${cls}">${vt}</span>`;
}
function isKvStore() {
  return state.selectedStoreType === 'kv';
}

/** Syntax-highlight a JSON value into HTML. */
function prettyJson(obj) {
  const raw = JSON.stringify(obj, null, 2);
  return raw.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (m) => {
      let cls = 'json-number';
      if (/^"/.test(m)) cls = /:$/.test(m) ? 'json-key' : 'json-string';
      else if (/true|false/.test(m)) cls = 'json-bool';
      else if (/null/.test(m))       cls = 'json-null';
      return `<span class="${cls}">${esc(m)}</span>`;
    }
  );
}

// ── Toasts ────────────────────────────────────────────────────────────────────
function toast(msg, type = 'success', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function openModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal').classList.add('open');
}
function closeModal() {
  document.getElementById('modal').classList.remove('open');
  document.getElementById('modal-content').innerHTML = '';
}
function handleModalOverlayClick(e) {
  if (e.target === document.getElementById('modal')) closeModal();
}

// ── Connection ────────────────────────────────────────────────────────────────
async function connect() {
  const url = document.getElementById('base-url-input').value.trim();
  if (!url) return;
  state.baseUrl = url;
  Api.setBaseUrl(url);
  localStorage.setItem('minnal_base_url', url);

  const badge = document.getElementById('health-badge');
  badge.className = 'badge badge-unknown';
  badge.textContent = '● connecting…';

  try {
    const h = await Api.health();
    badge.className = 'badge badge-ok';
    badge.textContent = '● connected';
    document.getElementById('uptime-label').textContent = 'up ' + fmtUptime(h.uptime_s);
  } catch {
    badge.className = 'badge badge-error';
    badge.textContent = '● unreachable';
    document.getElementById('uptime-label').textContent = '';
  }

  await loadStores();
}

// ── Stores ─────────────────────────────────────────────────────────────────────
async function loadStores() {
  // A single /stores list returns both kinds; each entry carries a `store_type`
  // ("doc"/"kv"). Partition locally (falling back to the value_type heuristic for
  // any entry that predates the discriminant).
  let all = [];
  try {
    all = (await Api.listStores()) ?? [];
  } catch (e) {
    toast('Failed to load stores: ' + e?.message, 'error');
  }
  const isKv = s => s.store_type === 'kv' || (s.store_type == null && s.value_type != null);
  state.stores   = all.filter(s => !isKv(s));
  state.kvStores = all.filter(isKv);

  renderSidebar();

  if (state.selectedStore) {
    const ns   = state.selectedStore.namespace;
    const list = isKvStore() ? state.kvStores : state.stores;
    const fresh = list.find(s => s.namespace === ns);
    state.selectedStore = fresh ?? null;
    if (!fresh) state.selectedStoreType = null;
    renderActiveTab();
  }
}

function renderSidebar() {
  const el = document.getElementById('store-list');
  const hasDoc = state.stores.length > 0;
  const hasKv  = state.kvStores.length > 0;

  if (!hasDoc && !hasKv) {
    el.innerHTML = '<div class="empty-sidebar">No stores yet</div>';
    return;
  }

  const selNs   = state.selectedStore?.namespace;
  const selType = state.selectedStoreType;
  const hasBoth = hasDoc && hasKv;

  const docItems = state.stores.map(s => `
    <div class="store-item ${selType === 'doc' && selNs === s.namespace ? 'active' : ''}"
         onclick="selectStore('${esc(s.namespace)}', 'doc')">
      <span class="store-name">${esc(s.namespace)}</span>
      ${keyTypeBadge(s.key_type)}
    </div>
  `).join('');

  const kvItems = state.kvStores.map(s => `
    <div class="store-item ${selType === 'kv' && selNs === s.namespace ? 'active' : ''}"
         onclick="selectStore('${esc(s.namespace)}', 'kv')">
      <span class="store-name">${esc(s.namespace)}</span>
      <span class="badge badge-kv">KV</span>
      ${kvValueTypeBadge(s.value_type)}
    </div>
  `).join('');

  if (hasBoth) {
    el.innerHTML =
      `<div class="store-section-title">Doc</div>${docItems}` +
      `<div class="store-section-title">KV</div>${kvItems}`;
  } else {
    el.innerHTML = docItems + kvItems;
  }
}

function selectStore(ns, type = 'doc') {
  state.selectedStoreType = type;
  const list = type === 'kv' ? state.kvStores : state.stores;
  state.selectedStore = list.find(s => s.namespace === ns) ?? null;
  updateTabLabels();
  renderSidebar();
  if (state.activeTab === 'admin') return;
  if (state.activeTab === 'schema') renderSchemaTab();
  else switchTab(state.activeTab);
}

function updateTabLabels() {
  const kv = isKvStore();
  const docsBtn = document.querySelector('.tab-btn[data-tab="documents"]');
  if (docsBtn) docsBtn.textContent = kv ? 'KV' : 'Documents';
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(name) {
  state.activeTab = name;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.id === `tab-${name}`);
  });
  updateTabLabels();
  renderActiveTab();
}

function renderActiveTab() {
  const t = state.activeTab;
  if      (t === 'schema')    renderSchemaTab();
  else if (t === 'documents') renderDocumentsTab();
  else if (t === 'query')     renderQueryTab();
  else if (t === 'admin')     renderAdminTab();
}

// ── Schema tab ────────────────────────────────────────────────────────────────
function renderSchemaTab() {
  const el = document.getElementById('tab-schema');
  const s  = state.selectedStore;
  if (!s) {
    el.innerHTML = `<div class="welcome">
      <p class="welcome-icon">🗄</p>
      <p>Select a store from the sidebar or create a new one.</p></div>`;
    return;
  }

  if (isKvStore()) { renderKvSchemaTab(el, s); return; }

  const indices       = s.indices ?? [];
  const attrs         = s.attributes ?? [];
  const embedFields   = new Set(s.embedding_fields ?? []);
  const limit         = 5;

  const indiceRows = indices.length
    ? indices.map(ix => `
        <tr>
          <td class="text-mono">${esc(ix.field)}</td>
          <td>${idxTypeBadge(ix.index_type)}</td>
          <td><span class="badge badge-indexed">● Active</span></td>
          <td id="progress-${esc(ix.field)}"></td>
          <td>
            <button class="btn btn-xs btn-danger"
                    onclick="confirmDropIndex('${esc(s.namespace)}','${esc(ix.field)}')">
              Drop
            </button>
          </td>
        </tr>`).join('')
    : '<tr><td colspan="5" class="text-muted" style="padding:12px">No indices defined</td></tr>';

  const attrRows = attrs.length
    ? attrs.map(a => `
        <tr>
          <td class="text-mono">${esc(a.name)}</td>
          <td>${idxTypeBadge(a.attr_type)}</td>
          <td>${a.description ? esc(a.description) : '<span class="text-muted">—</span>'}</td>
          <td style="text-align:center">
            ${embedFields.has(a.name) ? '<span class="badge badge-indexed">✓ Embed</span>' : ''}
          </td>
          <td>
            <div class="gap-8">
              <button class="btn btn-xs btn-ghost"
                      onclick="showEditAttributeModal('${esc(s.namespace)}','${esc(a.name)}','${esc(a.attr_type)}','${esc(a.description??'')}')">
                Edit
              </button>
              <button class="btn btn-xs btn-danger"
                      onclick="confirmRemoveAttribute('${esc(s.namespace)}','${esc(a.name)}')">
                Remove
              </button>
            </div>
          </td>
        </tr>`).join('')
    : '<tr><td colspan="5" class="text-muted" style="padding:12px">No attributes defined</td></tr>';

  el.innerHTML = `
    <div class="store-header">
      <span class="store-ns">${esc(s.namespace)}</span>
      ${keyTypeBadge(s.key_type)}
      ${s.semantic_search_enabled
          ? '<span class="badge badge-indexed">✨ Semantic ON</span>'
          : '<span class="badge badge-attr">✨ Semantic OFF</span>'}
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn-ghost btn-sm"
                onclick="adminExportSchema('${esc(s.namespace)}')">⬇ Export Schema</button>
        <button class="btn btn-danger btn-sm"
                onclick="confirmDeleteStore('${esc(s.namespace)}')">🗑 Delete Store</button>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <span class="section-title">INDICES (${indices.length} / ${limit})</span>
        <button class="btn btn-sm btn-accent"
                ${indices.length >= limit ? 'disabled title="Max 5 indices"' : ''}
                onclick="showAddIndexModal('${esc(s.namespace)}')">+ Add Index</button>
      </div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr>
            <th>Field</th><th>Type</th><th>Status</th><th style="width:200px">Progress</th><th></th>
          </tr></thead>
          <tbody>${indiceRows}</tbody>
        </table>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <span class="section-title">ATTRIBUTES</span>
        <button class="btn btn-sm btn-accent"
                ${s.semantic_search_enabled ? 'disabled title="A vector index already exists — drop it before adding a new one"' : ''}
                onclick="showAddAttributeModal('${esc(s.namespace)}')">+ Add Vector Index</button>
      </div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Name</th><th>Type</th><th>Description</th><th>Embed</th><th></th></tr></thead>
          <tbody>${attrRows}</tbody>
        </table>
      </div>
    </div>`;
}

function renderKvSchemaTab(el, s) {
  el.innerHTML = `
    <div class="store-header">
      <span class="store-ns">${esc(s.namespace)}</span>
      <span class="badge badge-kv">KV</span>
      ${keyTypeBadge(s.key_type)}
      ${kvValueTypeBadge(s.value_type)}
      ${s.semantic_search_enabled
          ? '<span class="badge badge-indexed">✨ Semantic ON</span>'
          : '<span class="badge badge-attr">✨ Semantic OFF</span>'}
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn-ghost btn-sm"
                onclick="adminExportKvSchema('${esc(s.namespace)}')">⬇ Export Schema</button>
        <button class="btn btn-danger btn-sm"
                onclick="confirmDeleteStore('${esc(s.namespace)}')">🗑 Delete Store</button>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <span class="section-title">KV STORE SCHEMA</span>
      </div>
      <div class="admin-grid" style="margin-top:0">
        <div class="admin-card">
          <div class="admin-card-title">CONFIGURATION</div>
          <div class="stat-row"><span class="stat-key">Namespace</span>
            <span class="stat-val text-mono">${esc(s.namespace)}</span></div>
          <div class="stat-row"><span class="stat-key">Key Type</span>
            <span class="stat-val">${keyTypeBadge(s.key_type)}</span></div>
          <div class="stat-row"><span class="stat-key">Value Type</span>
            <span class="stat-val">${kvValueTypeBadge(s.value_type)}</span></div>
          <div class="stat-row"><span class="stat-key">Semantic Search</span>
            <span class="stat-val">${s.semantic_search_enabled
              ? '<span class="badge badge-indexed">Enabled</span>'
              : '<span class="badge badge-attr">Disabled</span>'}</span></div>
          ${s.ns_id != null
            ? `<div class="stat-row"><span class="stat-key">NS ID</span>
               <span class="stat-val">#${s.ns_id}</span></div>` : ''}
        </div>
        <div class="admin-card">
          <div class="admin-card-title">RESTRICTIONS</div>
          <p class="text-muted" style="line-height:1.6">
            KV stores have typed keys (<strong>str</strong> or <strong>int</strong>) and
            typed values (<strong>int</strong>, <strong>str</strong>, <strong>f32</strong>,
            or <strong>vec_f32</strong>).<br><br>
            Field indices and attributes are not supported. Use the <em>KV</em> tab to
            get, set, and delete individual entries.
            ${s.semantic_search_enabled
              ? '<br><br>Semantic search is enabled — use the <em>Query</em> tab to search by text.'
              : ''}
          </p>
        </div>
      </div>
    </div>`;
}

// ── Index progress polling ─────────────────────────────────────────────────────
function startProgressPoll(ns, field) {
  const key = `${ns}::${field}`;
  if (state.progressPolls[key]) return;

  state.progressPolls[key] = setInterval(async () => {
    try {
      const progress = await Api.indicesProgressNs(ns);
      const cell = document.getElementById(`progress-${field}`);
      if (!cell) { stopProgressPoll(ns, field); return; }

      const build = (progress?.attribute_builds ?? []).find(b =>
        b.id?.kind === 'field' && b.id?.namespace === ns && b.id?.field === field
      );

      if (!build) {
        cell.innerHTML = '<span class="badge badge-indexed">✓ Built</span>';
        stopProgressPoll(ns, field);
        return;
      }

      const status = (build.status ?? '').toLowerCase();
      if (status === 'running') {
        const pct = build.total > 0 ? (build.indexed / build.total * 100) : 0;
        cell.innerHTML = `
          <div class="progress-wrap"><div class="progress-bar" style="width:${pct.toFixed(1)}%"></div></div>
          <div class="progress-label">${pct.toFixed(1)}% (${fmt(build.indexed)} / ${fmt(build.total)})</div>`;
      } else if (status === 'complete') {
        cell.innerHTML = '<span class="badge badge-indexed">✓ Built</span>';
        stopProgressPoll(ns, field);
      } else {
        cell.innerHTML = `<span class="badge badge-error">${esc(build.status)}</span>`;
        stopProgressPoll(ns, field);
      }
    } catch { stopProgressPoll(ns, field); }
  }, 2000);
}

function stopProgressPoll(ns, field) {
  const key = `${ns}::${field}`;
  clearInterval(state.progressPolls[key]);
  delete state.progressPolls[key];
}

// ── Cursor-based scan pagination ──────────────────────────────────────────────
function _getScanState(id) {
  if (!state.scanCursors[id]) state.scanCursors[id] = { stack: [null], idx: 0 };
  return state.scanCursors[id];
}
function resetScanCursors(id)  { state.scanCursors[id] = { stack: [null], idx: 0 }; }
function currentScanCursor(id) { const s = _getScanState(id); return s.stack[s.idx] ?? null; }
function isScanFirstPage(id)   { return _getScanState(id).idx === 0; }
function getScanPageNum(id)    { return _getScanState(id).idx + 1; }
function advanceScan(id, nextCursor) {
  const s = _getScanState(id);
  s.stack = s.stack.slice(0, s.idx + 1);
  s.stack.push(nextCursor);
  s.idx++;
}
function retreatScan(id) { const s = _getScanState(id); if (s.idx > 0) s.idx--; }
function runScanById(id) {
  const fns = { docRange: doRangeScan, docQueryRange: doQueryRangeScan,
                docPrefix: doPrefixScan, kvRange: doKvRangeScan, kvPrefix: doKvPrefixScan };
  fns[id]?.();
}
function freshScan(id) { resetScanCursors(id); runScanById(id); }
function scanNext(id)  { advanceScan(id, state._nextCursors?.[id]); runScanById(id); }
function scanPrev(id)  { retreatScan(id); runScanById(id); }

// ── Create store modal ────────────────────────────────────────────────────────
function showCreateStoreModal() {
  state.fieldRowSeq = 0;
  openModal(`
    <div class="modal-title">Create New Store</div>

    <div class="modal-section">
      <div class="form-group" style="margin-bottom:16px">
        <label>STORE TYPE</label>
        <div class="radio-group">
          <label><input type="radio" name="cs-type" value="doc" checked
                        onchange="onCreateStoreTypeChange()"> Doc Store</label>
          <label><input type="radio" name="cs-type" value="kv"
                        onchange="onCreateStoreTypeChange()"> KV Store</label>
        </div>
      </div>
      <div class="form-group" style="margin-bottom:16px">
        <label>NAMESPACE</label>
        <input type="text" id="cs-ns" placeholder="e.g. users, orders, products"
               style="max-width:320px" />
      </div>

      <!-- Doc Store key types -->
      <div id="cs-doc-key" class="form-group">
        <label>KEY TYPE</label>
        <div class="radio-group">
          <label><input type="radio" name="cs-kt" value="uuid" checked
                        onchange="onDocKeyTypeChange()"> uuid</label>
          <label><input type="radio" name="cs-kt" value="u64"
                        onchange="onDocKeyTypeChange()"> u64</label>
          <label><input type="radio" name="cs-kt" value="u128"
                        onchange="onDocKeyTypeChange()"> u128</label>
          <label><input type="radio" name="cs-kt" value="str"
                        onchange="onDocKeyTypeChange()"> str</label>
        </div>
        <div id="cs-doc-key-note" class="text-muted" style="margin-top:6px;display:none">
          UTF-8, 1–${MAX_STR_KEY_LEN} bytes, ordered lexicographically — so range and
          prefix scans read in string order. Vary the <strong>leading</strong> bytes:
          keys sharing their first 8 bytes (e.g. <code style="font-family:monospace">user:profile:…</code>)
          all land in one storage bucket.
        </div>
      </div>

      <!-- KV Store fields (hidden by default) -->
      <div id="cs-kv-fields" style="display:none">
        <div class="form-group" style="margin-bottom:12px">
          <label>KEY TYPE</label>
          <div class="radio-group">
            <label><input type="radio" name="cs-kv-kt" value="str" checked> str</label>
            <label><input type="radio" name="cs-kv-kt" value="int"> int</label>
          </div>
          <div class="text-muted" style="margin-top:6px">
            str keys are UTF-8 and capped at ${MAX_STR_KEY_LEN} bytes.
          </div>
        </div>
        <div class="form-group" style="margin-bottom:12px">
          <label>VALUE TYPE</label>
          <div class="radio-group">
            <label><input type="radio" name="cs-kv-vt" value="str" checked
                          onchange="onKvValueTypeChange()"> str</label>
            <label><input type="radio" name="cs-kv-vt" value="int"
                          onchange="onKvValueTypeChange()"> int</label>
            <label><input type="radio" name="cs-kv-vt" value="f32"
                          onchange="onKvValueTypeChange()"> f32</label>
            <label><input type="radio" name="cs-kv-vt" value="vec_f32"
                          onchange="onKvValueTypeChange()"> vec_f32</label>
          </div>
        </div>
        <div id="cs-kv-semantic-row" class="form-group">
          <label class="radio-group" style="gap:8px">
            <input type="checkbox" id="cs-kv-semantic" />
            Enable semantic search <span class="text-muted">(str value type only)</span>
          </label>
        </div>
      </div>
    </div>

    <!-- Doc Store: fields builder (hidden for KV) -->
    <div id="cs-doc-fields-section" class="modal-section">
      <div class="modal-section-title">FIELDS
        <span class="text-muted" style="font-weight:400;margin-left:8px">
          — toggle "Indexed" to control whether a field becomes an index or attribute
        </span>
      </div>
      <div class="field-builder-header">
        <span>Field Name</span><span>Type</span><span style="text-align:center">Indexed</span>
        <span>Description</span><span style="text-align:center" title="Check to include this field in semantic search embedding (str type only)">Embed</span><span></span>
      </div>
      <div id="cs-fields" class="field-builder"></div>
      <div class="add-field-row">
        <button class="btn btn-sm btn-ghost" onclick="addCreateStoreField()">+ Add Field</button>
      </div>
    </div>

    <!-- Doc Store: semantic search -->
    <div id="cs-doc-semantic-section" class="modal-section">
      <div class="modal-section-title">SEMANTIC SEARCH</div>
      <div class="form-group">
        <label class="radio-group" style="gap:8px">
          <input type="checkbox" id="cs-semantic-enabled" onchange="onSemanticEnabledChange()" />
          Enable semantic search — check one or more <strong>Embed</strong> fields above (str type only)
        </label>
      </div>
    </div>

    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-accent" onclick="submitCreateStore()">Create Store</button>
    </div>
  `);
  addCreateStoreField();
}

function onCreateStoreTypeChange() {
  const isKv = document.querySelector('input[name="cs-type"]:checked')?.value === 'kv';
  document.getElementById('cs-doc-key').style.display          = isKv ? 'none' : '';
  document.getElementById('cs-kv-fields').style.display        = isKv ? '' : 'none';
  document.getElementById('cs-doc-fields-section').style.display = isKv ? 'none' : '';
  document.getElementById('cs-doc-semantic-section').style.display = isKv ? 'none' : '';
}

function onDocKeyTypeChange() {
  const kt   = document.querySelector('input[name="cs-kt"]:checked')?.value;
  const note = document.getElementById('cs-doc-key-note');
  if (note) note.style.display = kt === 'str' ? '' : 'none';
}

function onKvValueTypeChange() {
  const vt = document.querySelector('input[name="cs-kv-vt"]:checked')?.value;
  const semRow = document.getElementById('cs-kv-semantic-row');
  const semCb  = document.getElementById('cs-kv-semantic');
  if (vt !== 'str') {
    semRow.style.opacity = '0.4';
    if (semCb) { semCb.checked = false; semCb.disabled = true; }
  } else {
    semRow.style.opacity = '';
    if (semCb) semCb.disabled = false;
  }
}

function addCreateStoreField() {
  const idx = state.fieldRowSeq++;
  const row = document.createElement('div');
  row.className = 'field-row';
  row.id = `cs-field-${idx}`;
  row.innerHTML = `
    <input type="text" class="field-name" placeholder="field_name" />
    <select class="field-type" onchange="onFieldTypeChange(this, ${idx})">
      <option value="str">str</option>
      <option value="int">int</option>
      <option value="bool">bool</option>
    </select>
    <label class="indexed-toggle">
      <input type="checkbox" class="field-indexed"
             onchange="onIndexedChange(this, ${idx})" />
      Indexed
    </label>
    <input type="text" class="field-desc" placeholder="description (optional)" />
    <label class="embed-toggle" style="text-align:center" title="Include this str field in semantic search embedding">
      <input type="checkbox" class="field-semantic"
             onchange="onEmbedFieldToggle()" />
    </label>
    <button class="field-remove-btn" onclick="removeCreateStoreField(${idx})" title="Remove">✕</button>
  `;
  document.getElementById('cs-fields').appendChild(row);
}

function onIndexedChange(cb, idx) {
  const row  = document.getElementById(`cs-field-${idx}`);
  const desc = row.querySelector('.field-desc');
  desc.disabled = cb.checked;
  if (cb.checked) desc.value = '';
  // Indexed fields cannot be embedding fields
  const embedCb = row.querySelector('.field-semantic');
  if (cb.checked && embedCb.checked) {
    embedCb.checked = false;
    syncSemanticEnabled();
  }
  embedCb.disabled = cb.checked;
}

function removeCreateStoreField(idx) {
  const row = document.getElementById(`cs-field-${idx}`);
  const wasEmbed = row?.querySelector('.field-semantic')?.checked;
  row?.remove();
  if (wasEmbed) syncSemanticEnabled();
}

function onFieldTypeChange(select, idx) {
  const row    = document.getElementById(`cs-field-${idx}`);
  const embedCb = row.querySelector('.field-semantic');
  const isStr  = select.value === 'str';
  if (!isStr && embedCb.checked) {
    embedCb.checked = false;
    syncSemanticEnabled();
  }
  // Only str fields are eligible for embedding; also respect indexed-disabled state
  const indexed = row.querySelector('.field-indexed').checked;
  embedCb.disabled = !isStr || indexed;
}

function onEmbedFieldToggle() {
  // Auto-enable/disable the semantic search checkbox based on current selections
  syncSemanticEnabled();
}

function syncSemanticEnabled() {
  const anyChecked = document.querySelectorAll('#cs-fields .field-semantic:checked').length > 0;
  document.getElementById('cs-semantic-enabled').checked = anyChecked;
}

function onSemanticEnabledChange() {
  // If the user manually unchecks, clear all embed checkbox selections
  if (!document.getElementById('cs-semantic-enabled').checked) {
    document.querySelectorAll('#cs-fields .field-semantic').forEach(cb => { cb.checked = false; });
  }
}

async function submitCreateStore() {
  const ns       = document.getElementById('cs-ns').value.trim();
  if (!ns) { toast('Namespace is required', 'error'); return; }
  const storeType = document.querySelector('input[name="cs-type"]:checked')?.value ?? 'doc';

  const btn = document.querySelector('#modal-content .btn-accent');
  btn.disabled = true; btn.textContent = 'Creating…';

  if (storeType === 'kv') {
    const keyType   = document.querySelector('input[name="cs-kv-kt"]:checked')?.value ?? 'str';
    const valueType = document.querySelector('input[name="cs-kv-vt"]:checked')?.value ?? 'str';
    const semantic  = document.getElementById('cs-kv-semantic')?.checked ?? false;
    if (semantic && valueType !== 'str') {
      toast('Semantic search requires value_type = str', 'error');
      btn.disabled = false; btn.textContent = 'Create Store'; return;
    }
    const payload = { namespace: ns, store_type: 'kv', key_type: keyType, value_type: valueType };
    if (semantic) payload.semantic_search_enabled = true;
    try {
      await Api.createStore(payload);
      closeModal();
      toast(`KV store '${ns}' created`);
      await loadStores();
      selectStore(ns, 'kv');
      switchTab('schema');
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false; btn.textContent = 'Create Store';
    }
    return;
  }

  // Doc store path
  const keyType = document.querySelector('input[name="cs-kt"]:checked')?.value ?? 'uuid';
  const rows    = document.querySelectorAll('#cs-fields .field-row');
  const indices = [], attributes = [];

  rows.forEach(row => {
    const name    = row.querySelector('.field-name').value.trim();
    const type    = row.querySelector('.field-type').value;
    const indexed = row.querySelector('.field-indexed').checked;
    const desc    = row.querySelector('.field-desc').value.trim();
    if (!name) return;
    if (indexed) {
      indices.push({ field: name, index_type: type });
    } else {
      const a = { name, attr_type: type };
      if (desc) a.description = desc;
      attributes.push(a);
    }
  });

  if (indices.length > 5) {
    toast('Max 5 indexed fields allowed', 'error');
    btn.disabled = false; btn.textContent = 'Create Store'; return;
  }

  const semanticEnabled = document.getElementById('cs-semantic-enabled')?.checked ?? false;
  const embeddingFields = Array.from(
    document.querySelectorAll('#cs-fields .field-semantic:checked')
  ).map(cb => cb.closest('.field-row').querySelector('.field-name').value.trim())
   .filter(Boolean);

  if (semanticEnabled && embeddingFields.length === 0) {
    toast('Check at least one Embed field (str type) for semantic search', 'error');
    btn.disabled = false; btn.textContent = 'Create Store'; return;
  }

  const payload = { namespace: ns, store_type: 'doc', key_type: keyType, indices, attributes };
  if (semanticEnabled) {
    payload.semantic_search_enabled = true;
    payload.embedding_fields = embeddingFields;
  }

  try {
    await Api.createStore(payload);
    closeModal();
    toast(`Store '${ns}' created`);
    await loadStores();
    selectStore(ns, 'doc');
    switchTab('schema');
  } catch (e) {
    toast(e.message, 'error');
    btn.disabled = false; btn.textContent = 'Create Store';
  }
}

// ── Delete store ──────────────────────────────────────────────────────────────
function confirmDeleteStore(ns) {
  const typeLabel = isKvStore() ? 'KV store' : 'store';
  const detail    = isKvStore()
    ? 'all its entries and schema'
    : 'all its documents, indices, and schema';
  openModal(`
    <div class="modal-title">Delete ${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)}</div>
    <p class="confirm-msg">
      Permanently delete <span class="confirm-ns">${esc(ns)}</span> and ${detail}?
      This cannot be undone.
    </p>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="doDeleteStore('${esc(ns)}')">Delete</button>
    </div>
  `);
}

async function doDeleteStore(ns) {
  try {
    // DELETE /stores/{ns} resolves the kind from the stored schema.
    await Api.deleteStore(ns);
    closeModal();
    toast(`Store '${ns}' deleted`);
    if (state.selectedStore?.namespace === ns) {
      state.selectedStore = null;
      state.selectedStoreType = null;
      updateTabLabels();
    }
    await loadStores();
    renderSchemaTab();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Add index modal ───────────────────────────────────────────────────────────
function showAddIndexModal(ns) {
  openModal(`
    <div class="modal-title">Add Index — ${esc(ns)}</div>
    <div class="modal-section">
      <div class="form-group" style="margin-bottom:14px">
        <label>FIELD NAME</label>
        <input type="text" id="ai-field" placeholder="e.g. status" style="max-width:280px" />
      </div>
      <div class="form-group">
        <label>INDEX TYPE</label>
        <select id="ai-type" style="max-width:160px">
          <option value="str">str</option>
          <option value="int">int</option>
          <option value="bool">bool</option>
        </select>
      </div>
      <p class="text-muted" style="margin-top:10px">
        If the store already has documents, a background rebuild will start automatically.
      </p>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-accent" onclick="submitAddIndex('${esc(ns)}')">Add Index</button>
    </div>
  `);
}

async function submitAddIndex(ns) {
  const field = document.getElementById('ai-field').value.trim();
  const type  = document.getElementById('ai-type').value;
  if (!field) { toast('Field name is required', 'error'); return; }

  try {
    await Api.addIndex(ns, { field, index_type: type });
    closeModal();
    toast(`Index on '${field}' added — rebuild may be running`);
    await loadStores();
    renderSchemaTab();
    // Start progress polling for the new index
    setTimeout(() => startProgressPoll(ns, field), 500);
  } catch (e) { toast(e.message, 'error'); }
}

// ── Drop index ────────────────────────────────────────────────────────────────
function confirmDropIndex(ns, field) {
  openModal(`
    <div class="modal-title">Drop Index</div>
    <p class="confirm-msg">
      Drop the index on <span class="confirm-ns">${esc(field)}</span> in
      <strong>${esc(ns)}</strong>?
      The field data is kept; the field becomes a plain attribute.
    </p>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="doDropIndex('${esc(ns)}','${esc(field)}')">Drop Index</button>
    </div>
  `);
}

async function doDropIndex(ns, field) {
  try {
    await Api.dropIndex(ns, field);
    stopProgressPoll(ns, field);
    closeModal();
    toast(`Index on '${field}' dropped`);
    await loadStores();
    renderSchemaTab();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Add vector index attribute ────────────────────────────────────────────────
function showAddAttributeModal(ns) {
  openModal(`
    <div class="modal-title">Add Vector Index — ${esc(ns)}</div>
    <div class="modal-section">
      <div class="modal-section-title">EMBEDDING FIELDS</div>
      <p class="text-muted" style="margin:0 0 12px">
        Each name declares a new <strong>str</strong> attribute that feeds the namespace's
        single vector index. The text of all listed fields is embedded together for
        semantic search. To change the field set later, drop the vector index and add it again.
      </p>
      <div id="vec-fields" class="field-builder"></div>
      <div class="add-field-row">
        <button class="btn btn-sm btn-ghost" onclick="addVectorIndexField()">+ Add Field</button>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-accent" onclick="submitAddVectorIndex('${esc(ns)}')">Create Vector Index</button>
    </div>
  `);
  addVectorIndexField();
}

function addVectorIndexField() {
  const row = document.createElement('div');
  row.className = 'vec-field-row';
  row.innerHTML = `
    <input type="text" class="vec-field-input" placeholder="e.g. description" />
    <button class="field-remove-btn" onclick="this.closest('.vec-field-row').remove()" title="Remove">✕</button>
  `;
  document.getElementById('vec-fields').appendChild(row);
}

function showEditAttributeModal(ns, name, type, desc) {
  openModal(`
    <div class="modal-title">Edit Attribute — ${esc(name)}</div>
    <div class="modal-section">
      <div class="form-group" style="margin-bottom:14px">
        <label>NAME</label>
        <input type="text" value="${esc(name)}" disabled style="max-width:280px;opacity:.6" />
      </div>
      <div class="form-group" style="margin-bottom:14px">
        <label>TYPE</label>
        <select id="attr-type" style="max-width:160px">
          <option value="str"  ${type==='str'  ?'selected':''}>str</option>
          <option value="int"  ${type==='int'  ?'selected':''}>int</option>
          <option value="bool" ${type==='bool' ?'selected':''}>bool</option>
        </select>
      </div>
      <div class="form-group">
        <label>DESCRIPTION <span class="text-muted">(optional)</span></label>
        <input type="text" id="attr-desc" value="${esc(desc)}" placeholder="short description" />
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-accent"
              onclick="submitUpdateAttribute('${esc(ns)}','${esc(name)}')">Save</button>
    </div>
  `);
}

async function submitAddVectorIndex(ns) {
  const fields = [...document.querySelectorAll('#vec-fields .vec-field-input')]
    .map(i => i.value.trim())
    .filter(Boolean);
  if (fields.length === 0) { toast('At least one field is required', 'error'); return; }
  if (new Set(fields).size !== fields.length) { toast('Duplicate field names', 'error'); return; }
  try {
    await Api.amendSchema(ns, { op: 'enable_vector_index', fields });
    closeModal();
    toast(`Vector index created over ${fields.length} field${fields.length !== 1 ? 's' : ''}`);
    await loadStores(); renderSchemaTab();
  } catch (e) { toast(e.message, 'error'); }
}

async function submitUpdateAttribute(ns, name) {
  const type = document.getElementById('attr-type').value;
  const desc = document.getElementById('attr-desc').value.trim();
  const op = { op: 'update_attribute', name, attr_type: type };
  if (desc) op.description = desc;
  try {
    await Api.amendSchema(ns, op);
    closeModal(); toast(`Attribute '${name}' updated`);
    await loadStores(); renderSchemaTab();
  } catch (e) { toast(e.message, 'error'); }
}

function confirmRemoveAttribute(ns, name) {
  openModal(`
    <div class="modal-title">Remove Attribute</div>
    <p class="confirm-msg">
      Remove attribute <span class="confirm-ns">${esc(name)}</span> from the schema of
      <strong>${esc(ns)}</strong>?
      Existing document data is unaffected.
    </p>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger"
              onclick="doRemoveAttribute('${esc(ns)}','${esc(name)}')">Remove</button>
    </div>
  `);
}

async function doRemoveAttribute(ns, name) {
  try {
    await Api.amendSchema(ns, { op: 'remove_attribute', name });
    closeModal(); toast(`Attribute '${name}' removed`);
    await loadStores(); renderSchemaTab();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Documents / KV tab ────────────────────────────────────────────────────────
function renderDocumentsTab() {
  const el = document.getElementById('tab-documents');
  const rangeLimit = parseInt(document.getElementById('range-limit')?.value) || 20;
  const s  = state.selectedStore;
  if (!s) {
    el.innerHTML = `<div class="welcome"><p class="welcome-icon">📄</p>
      <p>Select a store first to browse and edit entries.</p></div>`;
    return;
  }

  if (isKvStore()) { renderKvTab(el, s); return; }

  const sub = state.docSubTab;
  el.innerHTML = `
    <div class="sub-tab-nav">
      ${['get','put','delete','range'].map(t => `
        <button class="sub-tab-btn ${sub===t?'active':''}"
                onclick="switchDocSubTab('${t}')">${t === 'range' ? 'Range Scan' : t.charAt(0).toUpperCase()+t.slice(1)}</button>
      `).join('')}
    </div>

    <!-- GET -->
    <div id="doc-get" class="sub-panel ${sub==='get'?'active':''}">
      <div class="form-row" style="margin-bottom:14px">
        <div class="form-group" style="flex:1">
          <label>DOCUMENT ID</label>
          <input type="text" id="get-id" placeholder="${docIdPlaceholder(s)}" />
        </div>
        <button class="btn btn-accent" onclick="doGetDoc()">Fetch</button>
      </div>
      <div id="get-result"></div>
    </div>

    <!-- PUT -->
    <div id="doc-put" class="sub-panel ${sub==='put'?'active':''}">
      <div class="form-row" style="margin-bottom:14px">
        <div class="form-group" style="flex:1">
          <label>DOCUMENT ID</label>
          <input type="text" id="put-id" placeholder="${docIdPlaceholder(s, true)}" />
        </div>
        <button class="btn btn-accent" onclick="doPutDoc()">Upsert</button>
      </div>
      <div class="form-group" style="margin-bottom:10px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <label>JSON BODY</label>
          <button class="btn btn-sm btn-secondary" onclick="triggerJsonFilePicker()">📁 Browse JSON File</button>
        </div>
        <textarea id="put-body" rows="10" placeholder='{"name": "Alice", "status": "active", "age": 30}'></textarea>
      </div>
      <div id="put-result"></div>
    </div>

    <!-- DELETE -->
    <div id="doc-delete" class="sub-panel ${sub==='delete'?'active':''}">
      <div class="form-row" style="margin-bottom:14px">
        <div class="form-group" style="flex:1">
          <label>DOCUMENT ID</label>
          <input type="text" id="del-id" placeholder="${docIdPlaceholder(s, true)}" />
        </div>
        <button class="btn btn-danger" onclick="confirmDeleteDoc()">Delete</button>
      </div>
      <div id="del-result"></div>
    </div>

    <!-- RANGE SCAN -->
    <div id="doc-range" class="sub-panel ${sub==='range'?'active':''}">
      <div class="form-row" style="margin-bottom:14px">
        <div class="form-group" style="flex:1">
          <label>START KEY <span class="text-muted">(inclusive)</span></label>
          <input type="text" id="range-start" placeholder="${docRangeStartPlaceholder(s)}" />
        </div>
        <div class="form-group" style="flex:1">
          <label>END KEY <span class="text-muted">(exclusive, optional)</span></label>
          <input type="text" id="range-end" placeholder="leave blank for open scan" />
        </div>
        <div class="form-group" style="max-width:100px">
          <label>LIMIT</label>
          <input type="number" id="range-limit" value="${rangeLimit}" min="1" max="500" />
        </div>
        <button class="btn btn-accent" onclick="freshScan('docRange')">Scan</button>
      </div>
      <div id="range-result"></div>
    </div>
  `;
}

function renderKvTab(el, s) {
  const sub = state.docSubTab === 'put' ? 'set' : state.docSubTab;
  const validSubs = ['get', 'set', 'delete'];
  const activeSub = validSubs.includes(sub) ? sub : 'get';

  const keyPlaceholder = s.key_type === 'int' ? 'e.g. 42' : 'e.g. session:abc123';

  const valueInput = (() => {
    switch (s.value_type) {
      case 'int':
        return `<input type="number" id="kv-value" placeholder="e.g. 42" style="max-width:240px" />`;
      case 'f32':
        return `<input type="number" id="kv-value" placeholder="e.g. 3.14" step="any" style="max-width:240px" />`;
      case 'vec_f32':
        return `<textarea id="kv-value" rows="4" placeholder="[0.1, 0.2, 0.3, ...]"></textarea>`;
      default: // str
        return `<input type="text" id="kv-value" placeholder="e.g. hello world" />`;
    }
  })();

  el.innerHTML = `
    <div class="sub-tab-nav">
      ${['get','set','delete'].map(t => `
        <button class="sub-tab-btn ${activeSub===t?'active':''}"
                onclick="switchKvSubTab('${t}')">${t.charAt(0).toUpperCase()+t.slice(1)}</button>
      `).join('')}
    </div>

    <!-- GET -->
    <div id="kv-get" class="sub-panel ${activeSub==='get'?'active':''}">
      <div class="form-row" style="margin-bottom:14px">
        <div class="form-group" style="flex:1">
          <label>KEY</label>
          <input type="${s.key_type === 'int' ? 'number' : 'text'}" id="kv-get-key"
                 placeholder="${keyPlaceholder}" />
        </div>
        <button class="btn btn-accent" onclick="doGetKv()">Fetch</button>
      </div>
      <div id="kv-get-result"></div>
    </div>

    <!-- SET -->
    <div id="kv-set" class="sub-panel ${activeSub==='set'?'active':''}">
      <div class="form-row" style="margin-bottom:14px">
        <div class="form-group" style="flex:1">
          <label>KEY</label>
          <input type="${s.key_type === 'int' ? 'number' : 'text'}" id="kv-set-key"
                 placeholder="${keyPlaceholder}" />
        </div>
        <button class="btn btn-accent" onclick="doPutKv()">Set</button>
      </div>
      <div class="form-group" style="margin-bottom:10px">
        <label>VALUE <span class="badge badge-kv" style="margin-left:4px">${esc(s.value_type)}</span></label>
        ${valueInput}
      </div>
      <div id="kv-set-result"></div>
    </div>

    <!-- DELETE -->
    <div id="kv-delete" class="sub-panel ${activeSub==='delete'?'active':''}">
      <div class="form-row" style="margin-bottom:14px">
        <div class="form-group" style="flex:1">
          <label>KEY</label>
          <input type="${s.key_type === 'int' ? 'number' : 'text'}" id="kv-del-key"
                 placeholder="${keyPlaceholder}" />
        </div>
        <button class="btn btn-danger" onclick="confirmDeleteKv()">Delete</button>
      </div>
      <div id="kv-del-result"></div>
    </div>
  `;
}

function switchKvSubTab(t) {
  state.docSubTab = t;
  renderDocumentsTab();
}

async function doGetKv() {
  const key = document.getElementById('kv-get-key').value.trim();
  const ns  = state.selectedStore?.namespace;
  const el  = document.getElementById('kv-get-result');
  if (!key || !ns) return;
  const bad = strKeyIssue(state.selectedStore, key);
  if (bad) { el.innerHTML = `<div class="alert alert-error">${esc(bad)}</div>`; return; }
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const value = await Api.getKv(ns, key);
    if (value == null) {
      el.innerHTML = '<div class="alert alert-error">Key not found</div>';
    } else {
      el.innerHTML = `
        <div class="results-header"><span class="result-count">1 result</span></div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Key</th><th>Value</th></tr></thead>
          <tbody><tr>
            <td class="text-mono">${esc(key)}</td>
            <td><div class="json-view" style="max-height:200px;overflow:auto">${prettyJson(value)}</div></td>
          </tr></tbody>
        </table></div>`;
    }
  } catch (e) {
    el.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
  }
}

async function doPutKv() {
  const key   = document.getElementById('kv-set-key').value.trim();
  const rawVal = document.getElementById('kv-value').value.trim();
  const ns    = state.selectedStore?.namespace;
  const el    = document.getElementById('kv-set-result');
  if (!key || !ns) return;
  const badKey = strKeyIssue(state.selectedStore, key);
  if (badKey) { el.innerHTML = `<div class="alert alert-error">${esc(badKey)}</div>`; return; }

  let value;
  const vt = state.selectedStore?.value_type;
  try {
    if (vt === 'int') {
      value = parseInt(rawVal, 10);
      if (isNaN(value)) throw new Error('Value must be an integer');
    } else if (vt === 'f32') {
      value = parseFloat(rawVal);
      if (isNaN(value)) throw new Error('Value must be a number');
    } else if (vt === 'vec_f32') {
      value = JSON.parse(rawVal);
      if (!Array.isArray(value)) throw new Error('Value must be a JSON array');
    } else {
      value = rawVal; // str — send as bare string JSON
    }
  } catch (parseErr) {
    el.innerHTML = `<div class="alert alert-error">${esc(parseErr.message)}</div>`;
    return;
  }

  el.innerHTML = '<div class="spinner"></div>';
  try {
    await Api.putKv(ns, key, value);
    el.innerHTML = '<div class="alert alert-success">Value set successfully</div>';
    toast('Value set');
  } catch (e) {
    el.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
  }
}

function confirmDeleteKv() {
  const key = document.getElementById('kv-del-key').value.trim();
  const ns  = state.selectedStore?.namespace;
  if (!key || !ns) { toast('Enter a key', 'error'); return; }
  const bad = strKeyIssue(state.selectedStore, key);
  if (bad) { toast(bad, 'error'); return; }
  openModal(`
    <div class="modal-title">Delete KV Entry</div>
    <p class="confirm-msg">
      Delete key <span class="confirm-ns">${esc(key)}</span>
      from <strong>${esc(ns)}</strong>?
    </p>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="doDeleteKv('${esc(ns)}','${esc(key)}')">Delete</button>
    </div>
  `);
}

async function doDeleteKv(ns, key) {
  try {
    await Api.deleteKv(ns, key);
    closeModal();
    const el = document.getElementById('kv-del-result');
    if (el) el.innerHTML = '<div class="alert alert-success">Key deleted</div>';
    toast('Key deleted');
  } catch (e) { toast(e.message, 'error'); }
}

function switchDocSubTab(t) {
  state.docSubTab = t;
  renderDocumentsTab();
}

async function doGetDoc() {
  const id  = document.getElementById('get-id').value.trim();
  const ns  = state.selectedStore?.namespace;
  const el  = document.getElementById('get-result');
  if (!id || !ns) return;
  const bad = strKeyIssue(state.selectedStore, id);
  if (bad) { el.innerHTML = `<div class="alert alert-error">${esc(bad)}</div>`; return; }
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const doc = await Api.getDoc(ns, id);
    el.innerHTML = doc == null
      ? '<div class="alert alert-error">Document not found</div>'
      : renderDocResults([{ id, doc }]);
  } catch (e) {
    el.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
  }
}

// File picker bridge for the PUT textarea
function triggerJsonFilePicker() {
  document.getElementById('json-file-input').click();
}

function handleJsonFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const parsed = JSON.parse(ev.target.result);
      const ta = document.getElementById('put-body');
      if (ta) {
        ta.value = JSON.stringify(parsed, null, 2);
        toast(`Loaded ${file.name}`);
      }
    } catch (err) {
      toast('Invalid JSON: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
  e.target.value = ''; // reset so same file can be re-selected
}

async function doPutDoc() {
  const id   = document.getElementById('put-id').value.trim();
  const body = document.getElementById('put-body').value.trim();
  const ns   = state.selectedStore?.namespace;
  const el   = document.getElementById('put-result');
  if (!id || !ns) return;
  const bad = strKeyIssue(state.selectedStore, id);
  if (bad) { el.innerHTML = `<div class="alert alert-error">${esc(bad)}</div>`; return; }
  let doc;
  try { doc = JSON.parse(body); }
  catch { el.innerHTML = '<div class="alert alert-error">Invalid JSON body</div>'; return; }
  el.innerHTML = '<div class="spinner"></div>';
  try {
    await Api.putDoc(ns, id, doc);
    el.innerHTML = '<div class="alert alert-success">Document upserted successfully</div>';
    toast('Document saved');
  } catch (e) {
    el.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
  }
}

function confirmDeleteDoc() {
  const id = document.getElementById('del-id').value.trim();
  const ns = state.selectedStore?.namespace;
  if (!id || !ns) { toast('Enter a document ID', 'error'); return; }
  const bad = strKeyIssue(state.selectedStore, id);
  if (bad) { toast(bad, 'error'); return; }
  openModal(`
    <div class="modal-title">Delete Document</div>
    <p class="confirm-msg">
      Delete document <span class="confirm-ns">${esc(id)}</span>
      from <strong>${esc(ns)}</strong>?
    </p>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="doDeleteDoc('${esc(ns)}','${esc(id)}')">Delete</button>
    </div>
  `);
}

async function doDeleteDoc(ns, id) {
  try {
    await Api.deleteDoc(ns, id);
    closeModal();
    const el = document.getElementById('del-result');
    if (el) el.innerHTML = '<div class="alert alert-success">Document deleted</div>';
    toast('Document deleted');
  } catch (e) { toast(e.message, 'error'); }
}

async function doRangeScan() {
  const start = document.getElementById('range-start').value.trim();
  const end   = document.getElementById('range-end').value.trim() || undefined;
  const limit = parseInt(document.getElementById('range-limit').value) || 20;
  const ns    = state.selectedStore?.namespace;
  const el    = document.getElementById('range-result');
  if (!start || !ns) { toast('Start key is required', 'error'); return; }
  const bad = strKeyIssue(state.selectedStore, start)
           ?? (end ? strKeyIssue(state.selectedStore, end) : null);
  if (bad) { el.innerHTML = `<div class="alert alert-error">${esc(bad)}</div>`; return; }
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const data   = await Api.rangeScan(ns, start, end, currentScanCursor('docRange'), limit);
    el.innerHTML = renderDocResults(data, 'docRange');
  } catch (e) {
    el.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
  }
}

// ── Query tab ─────────────────────────────────────────────────────────────────
function renderQueryTab() {
  const el = document.getElementById('tab-query');
  const qRangeLimit  = parseInt(document.getElementById('q-range-limit')?.value)  || 20;
  const qPrefixLimit = parseInt(document.getElementById('q-prefix-limit')?.value) || 20;
  const s  = state.selectedStore;
  if (!s) {
    el.innerHTML = `<div class="welcome"><p class="welcome-icon">🔍</p>
      <p>Select a store first to run queries.</p></div>`;
    return;
  }

  if (isKvStore()) { renderKvQueryTab(el, s); return; }

  const sub = state.querySubTab;
  const indices = s.indices ?? [];
  const indexHint = indices.length
    ? indices.map(i => `${i.field} (${i.index_type})`).join(', ')
    : 'No indices defined';
  const semanticTab = s.semantic_search_enabled
    ? `<button class="sub-tab-btn ${sub==='semantic'?'active':''}"
               onclick="switchQuerySubTab('semantic')">Semantic Search</button>` : '';

  el.innerHTML = `
    <div class="sub-tab-nav">
      <button class="sub-tab-btn ${sub==='predicate'?'active':''}"
              onclick="switchQuerySubTab('predicate')">Predicate Query</button>
      <button class="sub-tab-btn ${sub==='range'?'active':''}"
              onclick="switchQuerySubTab('range')">Range Scan</button>
      <button class="sub-tab-btn ${sub==='prefix'?'active':''}"
              onclick="switchQuerySubTab('prefix')">Prefix Scan</button>
      ${semanticTab}
    </div>

    <!-- Predicate -->
    <div id="q-predicate" class="sub-panel ${sub==='predicate'?'active':''}">
      <p class="text-muted" style="margin-bottom:10px">
        Indexed fields: <strong>${esc(indexHint)}</strong><br>
        Syntax: <code style="font-family:monospace">status = "active" AND age >= 18</code>
      </p>
      <div class="form-row" style="margin-bottom:14px">
        <div class="form-group" style="flex:1">
          <label>PREDICATE</label>
          <input type="text" id="q-pred-input" placeholder='status = "active" AND age >= 18' />
        </div>
        <div class="form-group" style="max-width:80px">
          <label>PAGE</label>
          <input type="number" id="q-pred-page" value="1" min="1" />
        </div>
        <div class="form-group" style="max-width:100px">
          <label>PAGE SIZE</label>
          <input type="number" id="q-pred-page-size" value="20" min="1" max="500" />
        </div>
        <button class="btn btn-accent" onclick="doPredicateQuery()">Execute</button>
      </div>
      <div id="q-pred-result"></div>
    </div>

    <!-- Range -->
    <div id="q-range" class="sub-panel ${sub==='range'?'active':''}">
      <div class="form-row" style="margin-bottom:14px">
        <div class="form-group" style="flex:1">
          <label>START KEY <span class="text-muted">(inclusive)</span></label>
          <input type="text" id="q-range-start" placeholder="${docRangeStartPlaceholder(s)}" />
        </div>
        <div class="form-group" style="flex:1">
          <label>END KEY <span class="text-muted">(exclusive, optional)</span></label>
          <input type="text" id="q-range-end" placeholder="leave blank for open scan" />
        </div>
        <div class="form-group" style="max-width:100px">
          <label>LIMIT</label>
          <input type="number" id="q-range-limit" value="${qRangeLimit}" min="1" max="500" />
        </div>
        <button class="btn btn-accent" onclick="freshScan('docQueryRange')">Scan</button>
      </div>
      <div id="q-range-result"></div>
    </div>

    <!-- Prefix -->
    <div id="q-prefix" class="sub-panel ${sub==='prefix'?'active':''}">
      <p class="text-muted" style="margin-bottom:10px">
        ${s.key_type === 'str'
          ? `Enter the doc ID prefix as a plain string (e.g. <code style="font-family:monospace">acme-</code> matches <code style="font-family:monospace">acme-1</code>). At most ${MAX_STR_KEY_LEN} UTF-8 bytes — a longer prefix could not match any key.`
          : 'Enter the doc ID prefix as a hex string (e.g. <code style="font-family:monospace">deadbeef</code> or a partial UUID without hyphens).'}
      </p>
      <div class="form-row" style="margin-bottom:14px">
        <div class="form-group" style="flex:1">
          <label>PREFIX <span class="text-muted">(${s.key_type === 'str' ? 'string' : 'hex bytes'})</span></label>
          <input type="text" id="q-prefix-input" placeholder="${s.key_type === 'str' ? 'e.g. acme-' : 'e.g. deadbeef or 550e8400e29b'}" />
        </div>
        <div class="form-group" style="max-width:100px">
          <label>LIMIT</label>
          <input type="number" id="q-prefix-limit" value="${qPrefixLimit}" min="1" max="500" />
        </div>
        <button class="btn btn-accent" onclick="freshScan('docPrefix')">Scan</button>
      </div>
      <div id="q-prefix-result"></div>
    </div>

    <!-- Semantic -->
    <div id="q-semantic" class="sub-panel ${sub==='semantic'?'active':''}">
      <div class="form-group" style="margin-bottom:14px">
        <label>SEARCH QUERY</label>
        <input type="text" id="q-sem-query" placeholder="e.g. senior Rust engineer with distributed systems experience" />
      </div>
      <div class="form-group" style="margin-bottom:14px">
        <label>PREDICATE FILTER <span class="text-muted">(optional)</span></label>
        <input type="text" id="q-sem-pred" placeholder='status = "active"' />
      </div>
      <div class="form-row" style="margin-bottom:14px;align-items:flex-end">
        <div class="form-group" style="max-width:120px">
          <label>TOP-K</label>
          <input type="number" id="q-sem-topk" value="10" min="1" max="100" />
        </div>
        <div class="form-group" style="max-width:80px">
          <label>PAGE</label>
          <input type="number" id="q-sem-page" value="1" min="1" />
        </div>
        <div class="form-group" style="max-width:100px">
          <label>PAGE SIZE</label>
          <input type="number" id="q-sem-page-size" value="20" min="1" max="500" />
        </div>
        <button class="btn btn-accent" onclick="doSemanticSearch()">Search</button>
      </div>
      <div id="q-sem-result"></div>
    </div>
  `;
}

function switchQuerySubTab(t) {
  state.querySubTab = t;
  renderQueryTab();
}

function renderKvQueryTab(el, s) {
  const kvRangeLimit  = parseInt(document.getElementById('kv-range-limit')?.value)  || 20;
  const kvPrefixLimit = parseInt(document.getElementById('kv-prefix-limit')?.value) || 20;
  // Normalise sub-tab: only 'range', 'prefix', 'semantic' are valid for KV
  const validKvSubs = ['range', 'prefix', 'semantic'];
  const sub = validKvSubs.includes(state.querySubTab) ? state.querySubTab : 'range';

  const keyPlaceholder = s.key_type === 'int' ? 'e.g. 42' : 'e.g. my-key';

  const semanticTab = s.semantic_search_enabled
    ? `<button class="sub-tab-btn ${sub==='semantic'?'active':''}"
               onclick="switchKvQuerySubTab('semantic')">Semantic Search</button>`
    : '';

  el.innerHTML = `
    <div class="sub-tab-nav">
      <button class="sub-tab-btn ${sub==='range'?'active':''}"
              onclick="switchKvQuerySubTab('range')">Range Scan</button>
      <button class="sub-tab-btn ${sub==='prefix'?'active':''}"
              onclick="switchKvQuerySubTab('prefix')">Prefix Scan</button>
      ${semanticTab}
    </div>

    <!-- Range Scan -->
    <div id="kv-q-range" class="sub-panel ${sub==='range'?'active':''}">
      <p class="text-muted" style="margin-bottom:10px">
        Scan entries whose key falls within [start, end). Leave <em>End</em> blank for an open-ended scan.
        Keys are compared as ${s.key_type === 'int' ? '<strong>integers</strong>' : '<strong>strings</strong>'}.
      </p>
      <div class="form-row" style="margin-bottom:14px">
        <div class="form-group" style="flex:1">
          <label>START KEY <span class="text-muted">(inclusive)</span></label>
          <input type="${s.key_type === 'int' ? 'number' : 'text'}"
                 id="kv-range-start" placeholder="${keyPlaceholder}" />
        </div>
        <div class="form-group" style="flex:1">
          <label>END KEY <span class="text-muted">(exclusive, optional)</span></label>
          <input type="${s.key_type === 'int' ? 'number' : 'text'}"
                 id="kv-range-end" placeholder="leave blank for open scan" />
        </div>
        <div class="form-group" style="max-width:100px">
          <label>LIMIT</label>
          <input type="number" id="kv-range-limit" value="${kvRangeLimit}" min="1" max="500" />
        </div>
        <button class="btn btn-accent" onclick="freshScan('kvRange')">Scan</button>
      </div>
      <div id="kv-range-result"></div>
    </div>

    <!-- Prefix Scan -->
    <div id="kv-q-prefix" class="sub-panel ${sub==='prefix'?'active':''}">
      <p class="text-muted" style="margin-bottom:10px">
        ${s.key_type === 'int'
          ? 'Enter a numeric prefix — returns all integer keys whose decimal representation starts with this string.'
          : 'Enter a string prefix — returns all keys that start with this value.'}
      </p>
      <div class="form-row" style="margin-bottom:14px">
        <div class="form-group" style="flex:1">
          <label>PREFIX</label>
          <input type="text" id="kv-prefix-input"
                 placeholder="${s.key_type === 'int' ? 'e.g. 4 (matches 4, 40, 41…)' : 'e.g. user:'}" />
        </div>
        <div class="form-group" style="max-width:100px">
          <label>LIMIT</label>
          <input type="number" id="kv-prefix-limit" value="${kvPrefixLimit}" min="1" max="500" />
        </div>
        <button class="btn btn-accent" onclick="freshScan('kvPrefix')">Scan</button>
      </div>
      <div id="kv-prefix-result"></div>
    </div>

    <!-- Semantic Search -->
    <div id="kv-q-semantic" class="sub-panel ${sub==='semantic'?'active':''}">
      <div class="form-group" style="margin-bottom:14px">
        <label>SEARCH QUERY</label>
        <input type="text" id="kv-sem-query"
               placeholder="e.g. error handling in distributed systems" />
      </div>
      <div class="form-row" style="margin-bottom:14px;align-items:flex-end">
        <div class="form-group" style="max-width:120px">
          <label>TOP-K</label>
          <input type="number" id="kv-sem-topk" value="10" min="1" max="100" />
        </div>
        <div class="form-group" style="max-width:80px">
          <label>PAGE</label>
          <input type="number" id="kv-sem-page" value="1" min="1" />
        </div>
        <div class="form-group" style="max-width:100px">
          <label>PAGE SIZE</label>
          <input type="number" id="kv-sem-page-size" value="20" min="1" max="500" />
        </div>
        <button class="btn btn-accent" onclick="doKvSemanticSearch()">Search</button>
      </div>
      <div id="kv-sem-result"></div>
    </div>
  `;
}

function switchKvQuerySubTab(t) {
  state.querySubTab = t;
  renderQueryTab();
}

async function doKvRangeScan() {
  const start = document.getElementById('kv-range-start').value.trim();
  const end   = document.getElementById('kv-range-end').value.trim() || undefined;
  const limit = parseInt(document.getElementById('kv-range-limit').value) || 20;
  const ns    = state.selectedStore?.namespace;
  const el    = document.getElementById('kv-range-result');
  if (!start || !ns) { toast('Start key is required', 'error'); return; }
  const bad = strKeyIssue(state.selectedStore, start)
           ?? (end ? strKeyIssue(state.selectedStore, end) : null);
  if (bad) { el.innerHTML = `<div class="alert alert-error">${esc(bad)}</div>`; return; }
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const data = await Api.kvRangeScan(ns, start, end, currentScanCursor('kvRange'), limit);
    el.innerHTML = renderKvScanResults(data, 'kvRange');
  } catch (e) {
    el.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
  }
}

async function doKvPrefixScan() {
  const prefix = document.getElementById('kv-prefix-input').value.trim();
  const limit  = parseInt(document.getElementById('kv-prefix-limit').value) || 20;
  const ns     = state.selectedStore?.namespace;
  const el     = document.getElementById('kv-prefix-result');
  if (!prefix || !ns) { toast('Prefix is required', 'error'); return; }
  const bad = strPrefixIssue(state.selectedStore, prefix);
  if (bad) { el.innerHTML = `<div class="alert alert-error">${esc(bad)}</div>`; return; }
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const data = await Api.kvPrefixScan(ns, prefix, currentScanCursor('kvPrefix'), limit);
    el.innerHTML = renderKvScanResults(data, 'kvPrefix');
  } catch (e) {
    el.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
  }
}

function renderKvScanResults(data, optsOrScanId) {
  const isCursorMode = typeof optsOrScanId === 'string';
  const isPaginated  = data && !Array.isArray(data) && 'results' in data;
  const results  = isPaginated ? data.results : (Array.isArray(data) ? data : []);
  const pageInfo = (!isCursorMode && isPaginated) ? data : null;
  const nextCursor = isCursorMode ? (data?.next_cursor ?? null) : null;

  if (!results?.length) return '<div class="alert alert-info">No results</div>';

  state._docResults = results;

  const countLabel = (isCursorMode || !pageInfo)
    ? `${results.length} result${results.length === 1 ? '' : 's'}`
    : `${fmt(pageInfo.total)} result${pageInfo.total === 1 ? '' : 's'}`;
  const header = `<div class="results-header"><span class="result-count">${countLabel}</span></div>`;
  const nav = isCursorMode
    ? renderCursorNav(optsOrScanId, nextCursor, results.length)
    : renderPageNav(pageInfo, optsOrScanId);

  const rows = results.map((r, i) => {
    return `
      <tr>
        ${cellVal(r.key)}
        ${cellVal(r.value)}
        <td style="white-space:nowrap">
          <button class="btn btn-xs btn-ghost"
                  onclick="showKvScanResultPayload(${i})">View</button>
        </td>
      </tr>`;
  }).join('');

  return header + nav + `<div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Key</th><th>Value</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function showKvScanResultPayload(idx) {
  const r = state._docResults?.[idx];
  if (!r) return;
  openModal(`
    <div class="modal-title">Entry — ${esc(String(r.key))}</div>
    <div class="json-view" style="max-height:60vh;overflow:auto;padding:12px">${prettyJson({ key: r.key, value: r.value })}</div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Close</button>
    </div>
  `);
}

async function doKvSemanticSearch() {
  const q        = document.getElementById('kv-sem-query').value.trim();
  const topK     = parseInt(document.getElementById('kv-sem-topk').value)      || 10;
  const pageNo   = parseInt(document.getElementById('kv-sem-page').value)      || 1;
  const pageSize = parseInt(document.getElementById('kv-sem-page-size').value) || 20;
  const ns       = state.selectedStore?.namespace;
  const el       = document.getElementById('kv-sem-result');
  if (!q || !ns) return;
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const data = await Api.kvSemanticSearch(ns, q, topK, pageNo, pageSize);
    el.innerHTML = renderKvSemanticResults(data, { pageInputId: 'kv-sem-page', actionFn: 'doKvSemanticSearch', pageSize });
  } catch (e) {
    el.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
  }
}

function renderKvSemanticResults(data, opts) {
  const isPaginated = data && !Array.isArray(data) && 'results' in data;
  const results  = isPaginated ? data.results : data;
  const pageInfo = isPaginated ? data : null;

  if (!results?.length) return '<div class="alert alert-info">No results</div>';

  state._semanticResults = results;

  const countLabel = pageInfo
    ? `${fmt(pageInfo.total)} result${pageInfo.total === 1 ? '' : 's'}`
    : `${results.length} result${results.length === 1 ? '' : 's'}`;
  const header = `<div class="results-header"><span class="result-count">${countLabel}</span></div>`;
  const nav = renderPageNav(pageInfo, opts);

  const rows = results.map((r, i) => `
    <tr>
      ${cellVal(r.key)}
      <td style="white-space:nowrap">${r.dot_product.toFixed(4)}</td>
      ${cellVal(r.value)}
      <td style="white-space:nowrap">
        <button class="btn btn-xs btn-ghost"
                onclick="showKvSemanticResultPayload(${i})">View</button>
      </td>
    </tr>`).join('');

  return header + nav + `<div class="tbl-wrap"><table class="tbl">
    <thead><tr>
      <th>Key</th><th>Dot Product</th><th>Value</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function showKvSemanticResultPayload(idx) {
  const r = state._semanticResults?.[idx];
  if (!r) return;
  const payload = {
    key:         r.key,
    dot_product: r.dot_product,
    error_bound: r.error_bound,
    value:       r.value ?? null,
  };
  openModal(`
    <div class="modal-title">Full Payload — ${esc(String(r.key))}</div>
    <div class="json-view" style="max-height:60vh;overflow:auto;padding:12px">${prettyJson(payload)}</div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Close</button>
    </div>
  `);
}

async function doPredicateQuery() {
  const pred     = document.getElementById('q-pred-input').value.trim();
  const pageNo   = parseInt(document.getElementById('q-pred-page').value)      || 1;
  const pageSize = parseInt(document.getElementById('q-pred-page-size').value) || 20;
  const ns       = state.selectedStore?.namespace;
  const el       = document.getElementById('q-pred-result');
  if (!pred || !ns) return;
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const data   = await Api.query(ns, pred, pageNo, pageSize);
    el.innerHTML = renderDocResults(data, { pageInputId: 'q-pred-page', actionFn: 'doPredicateQuery', pageSize });
  } catch (e) {
    el.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
  }
}

async function doQueryRangeScan() {
  const start = document.getElementById('q-range-start').value.trim();
  const end   = document.getElementById('q-range-end').value.trim() || undefined;
  const limit = parseInt(document.getElementById('q-range-limit').value) || 20;
  const ns    = state.selectedStore?.namespace;
  const el    = document.getElementById('q-range-result');
  if (!start || !ns) { toast('Start key is required', 'error'); return; }
  const bad = strKeyIssue(state.selectedStore, start)
           ?? (end ? strKeyIssue(state.selectedStore, end) : null);
  if (bad) { el.innerHTML = `<div class="alert alert-error">${esc(bad)}</div>`; return; }
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const data   = await Api.rangeScan(ns, start, end, currentScanCursor('docQueryRange'), limit);
    el.innerHTML = renderDocResults(data, 'docQueryRange');
  } catch (e) {
    el.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
  }
}

async function doPrefixScan() {
  const prefix = document.getElementById('q-prefix-input').value.trim();
  const limit  = parseInt(document.getElementById('q-prefix-limit').value) || 20;
  const ns     = state.selectedStore?.namespace;
  const el     = document.getElementById('q-prefix-result');
  if (!prefix || !ns) { toast('Prefix is required', 'error'); return; }
  const bad = strPrefixIssue(state.selectedStore, prefix);
  if (bad) { el.innerHTML = `<div class="alert alert-error">${esc(bad)}</div>`; return; }
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const data   = await Api.prefixScan(ns, prefix, currentScanCursor('docPrefix'), limit);
    el.innerHTML = renderDocResults(data, 'docPrefix');
  } catch (e) {
    el.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
  }
}

async function doSemanticSearch() {
  const q        = document.getElementById('q-sem-query').value.trim();
  const pred     = document.getElementById('q-sem-pred').value.trim() || undefined;
  const topK     = parseInt(document.getElementById('q-sem-topk').value)      || 10;
  const pageNo   = parseInt(document.getElementById('q-sem-page').value)      || 1;
  const pageSize = parseInt(document.getElementById('q-sem-page-size').value) || 20;
  const ns       = state.selectedStore?.namespace;
  const el       = document.getElementById('q-sem-result');
  if (!q || !ns) return;
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const data = pred
      ? await Api.semanticSearchFiltered(ns, q, pred, topK, pageNo, pageSize)
      : await Api.semanticSearch(ns, q, topK, pageNo, pageSize);
    el.innerHTML = renderSemanticResults(data, { pageInputId: 'q-sem-page', actionFn: 'doSemanticSearch', pageSize });
  } catch (e) {
    el.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
  }
}

// ── Result rendering ──────────────────────────────────────────────────────────
function cellVal(rawVal) {
  if (rawVal == null) return `<td class="cell-clip"><span class="text-muted">—</span></td>`;
  const str = typeof rawVal === 'object' ? JSON.stringify(rawVal, null, 2) : String(rawVal);
  return `<td class="cell-clip" title="${esc(str)}" onclick="showCellPopup(this)">${esc(str)}</td>`;
}

function showCellPopup(td) {
  const val = esc(td.getAttribute('title') ?? '');
  openModal(`
    <div class="modal-title">Cell Value</div>
    <div class="json-view" style="max-height:60vh;overflow:auto;padding:12px;white-space:pre-wrap;word-break:break-all">${val}</div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Close</button>
    </div>
  `);
}

function setPageAndRun(inputId, page, fnName) {
  const input = document.getElementById(inputId);
  if (input) input.value = Math.max(1, page);
  if (typeof window[fnName] === 'function') window[fnName]();
}

function renderPageNav(pageInfo, opts) {
  if (!pageInfo || !opts?.pageInputId || !opts?.actionFn) return '';
  const p = pageInfo.page_no;
  const totalPages = opts.pageSize > 0 ? Math.ceil(pageInfo.total / opts.pageSize) : null;
  const isFirst = p <= 1;
  const isLast  = totalPages != null ? p >= totalPages : false;
  const label = totalPages
    ? `Page ${p} of ${totalPages} &nbsp;·&nbsp; ${fmt(pageInfo.total)} total`
    : `Page ${p} &nbsp;·&nbsp; ${fmt(pageInfo.total)} total`;
  return `
    <div class="pagination-nav">
      <button class="pagination-btn" ${isFirst ? 'disabled' : ''}
              onclick="setPageAndRun('${opts.pageInputId}', ${p - 1}, '${opts.actionFn}')">← Prev</button>
      <span class="page-label">${label}</span>
      <button class="pagination-btn" ${isLast ? 'disabled' : ''}
              onclick="setPageAndRun('${opts.pageInputId}', ${p + 1}, '${opts.actionFn}')">Next →</button>
    </div>`;
}

function renderCursorNav(scanId, nextCursor, count) {
  state._nextCursors[scanId] = nextCursor;
  const isFirst = isScanFirstPage(scanId);
  const hasNext = nextCursor != null;
  const label   = `Page ${getScanPageNum(scanId)} &nbsp;·&nbsp; ${count} shown`;
  return `
    <div class="pagination-nav">
      <button class="pagination-btn" ${isFirst ? 'disabled' : ''}
              onclick="scanPrev('${scanId}')">← Prev</button>
      <span class="page-label">${label}</span>
      <button class="pagination-btn" ${!hasNext ? 'disabled' : ''}
              onclick="scanNext('${scanId}')">Next →</button>
    </div>`;
}

// A query answer is only as complete as the indices it read. When the response
// names degraded fields, the results may be MISSING rows — say so above them
// rather than letting a short answer pass for a complete one. Only fields this
// predicate actually touched are listed, so the warning is specific to the
// query, not to the namespace.
//
// Scans (range/prefix) never carry the field, so this renders nothing for them.
function renderDegradedBanner(data) {
  const fields = data?.degraded_fields ?? [];
  if (!fields.length) return '';
  const list = fields.map(f => `<span class="text-mono">${esc(f)}</span>`).join(', ');
  return `
    <div class="alert alert-warning">
      ⚠ <strong>Results may be incomplete.</strong>
      ${fields.length === 1 ? 'The index for' : 'The indices for'} ${list}
      ${fields.length === 1 ? 'is' : 'are'} known to be missing updates, so matching
      documents may be absent from this answer.
      Repair from <strong>Admin → Indices → Field Index Health</strong>, then re-run the query.
    </div>`;
}

function renderDocResults(data, optsOrScanId) {
  const isCursorMode = typeof optsOrScanId === 'string';
  const isPaginated  = data && !Array.isArray(data) && 'results' in data;
  const results  = isPaginated ? data.results : (Array.isArray(data) ? data : []);
  const pageInfo = (!isCursorMode && isPaginated) ? data : null;
  const nextCursor = isCursorMode ? (data?.next_cursor ?? null) : null;

  // Before the empty check: "no results" from a degraded index is exactly the
  // case the caller must not read as "nothing matched".
  const degraded = renderDegradedBanner(data);

  if (!results?.length) return degraded + '<div class="alert alert-info">No results</div>';

  // Persist so the popup callback can look up by row index
  state._docResults = results;

  const s           = state.selectedStore;
  const indexFields = (s?.indices    ?? []).map(ix => ix.field);
  const attrFields  = (s?.attributes ?? []).map(a  => a.name);
  const allFields   = [...indexFields, ...attrFields];

  const countLabel = (isCursorMode || !pageInfo)
    ? `${results.length} result${results.length === 1 ? '' : 's'}`
    : `${fmt(pageInfo.total)} result${pageInfo.total === 1 ? '' : 's'}`;
  const header = `<div class="results-header">
    <span class="result-count">${countLabel}</span></div>`;

  const nav = isCursorMode
    ? renderCursorNav(optsOrScanId, nextCursor, results.length)
    : renderPageNav(pageInfo, optsOrScanId);

  const fieldHeaders = allFields.map(f => `<th>${esc(f)}</th>`).join('');

  const rows = results.map((r, i) => {
    const doc = r.doc ?? {};
    const fieldCells = allFields.map(f => cellVal(doc[f] ?? null)).join('');
    return `
      <tr>
        ${cellVal(r.id)}
        ${fieldCells}
        <td style="white-space:nowrap">
          <button class="btn btn-xs btn-ghost"
                  onclick="showDocResultPayload(${i})">View JSON</button>
        </td>
      </tr>`;
  }).join('');

  return degraded + header + nav + `<div class="tbl-wrap"><table class="tbl">
    <thead><tr>
      <th style="min-width:100px">Document ID</th>
      ${fieldHeaders}
      <th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function showDocResultPayload(idx) {
  const r = state._docResults?.[idx];
  if (!r) return;
  openModal(`
    <div class="modal-title">Document — ${esc(String(r.id))}</div>
    <div class="json-view" style="max-height:60vh;overflow:auto;padding:12px">${prettyJson(r.doc)}</div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Close</button>
    </div>
  `);
}

function renderSemanticResults(data, opts) {
  const isPaginated = data && !Array.isArray(data) && 'results' in data;
  const results  = isPaginated ? data.results : data;
  const pageInfo = isPaginated ? data : null;

  // Filtered search carries the same signal: a degraded predicate index means
  // the ANN candidates were filtered against a short allow-list, so a nearest
  // neighbour can be dropped even though its vector is perfectly healthy.
  const degraded = renderDegradedBanner(data);

  if (!results?.length) return degraded + '<div class="alert alert-info">No results</div>';

  // Persist results so the popup callback can access them by index
  state._semanticResults = results;

  const s           = state.selectedStore;
  const indexFields = (s?.indices    ?? []).map(ix => ix.field);
  const attrFields  = (s?.attributes ?? []).map(a  => a.name);
  const allFields   = [...indexFields, ...attrFields];

  const countLabel = pageInfo
    ? `${fmt(pageInfo.total)} result${pageInfo.total === 1 ? '' : 's'}`
    : `${results.length} result${results.length===1?'':'s'}`;
  const header = `<div class="results-header">
    <span class="result-count">${countLabel}</span></div>`;

  const nav = renderPageNav(pageInfo, opts);

  const fieldHeaders = allFields.map(f => `<th>${esc(f)}</th>`).join('');

  const rows = results.map((r, i) => {
    let docObj = {};
    if (r.document) {
      if (typeof r.document === 'string') {
        try { docObj = JSON.parse(r.document); } catch { /* leave empty */ }
      } else {
        docObj = r.document;
      }
    }
    const fieldCells = allFields.map(f => cellVal(docObj[f] ?? null)).join('');
    return `
      <tr>
        ${cellVal(r.id)}
        <td style="white-space:nowrap">${r.dot_product.toFixed(4)}</td>
        ${fieldCells}
        <td style="white-space:nowrap">
          <button class="btn btn-xs btn-ghost"
                  onclick="showSemanticResultPayload(${i})">View JSON</button>
        </td>
      </tr>`;
  }).join('');

  return degraded + header + nav + `<div class="tbl-wrap"><table class="tbl">
    <thead><tr>
      <th style="min-width:100px">Document ID</th><th>Dot Product</th>
      ${fieldHeaders}
      <th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function showSemanticResultPayload(idx) {
  const r = state._semanticResults?.[idx];
  if (!r) return;

  let docObj = r.document;
  if (typeof docObj === 'string') {
    try { docObj = JSON.parse(docObj); } catch { /* keep as string */ }
  }

  const payload = {
    id:          r.id,
    dot_product: r.dot_product,
    error_bound: r.error_bound,
    document:    docObj ?? null,
  };

  openModal(`
    <div class="modal-title">Full Payload — ${esc(String(r.id))}</div>
    <div class="json-view" style="max-height:60vh;overflow:auto;padding:12px">${prettyJson(payload)}</div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Close</button>
    </div>
  `);
}

// ── Admin tab ─────────────────────────────────────────────────────────────────
async function renderAdminTab() {
  const el = document.getElementById('tab-admin');
  el.innerHTML = `
    <div class="sub-tab-nav admin-inner-nav">
      <button class="sub-tab-btn ${state.adminTab === 'storage' ? 'active' : ''}"
              data-admin-tab="storage" onclick="switchAdminTab('storage')">Storage</button>
      <button class="sub-tab-btn ${state.adminTab === 'ops' ? 'active' : ''}"
              data-admin-tab="ops" onclick="switchAdminTab('ops')">Ops Metrics</button>
      <button class="sub-tab-btn ${state.adminTab === 'index' ? 'active' : ''}"
              data-admin-tab="index" onclick="switchAdminTab('index')">Index Management</button>
    </div>
    <div id="admin-storage-panel" class="sub-panel ${state.adminTab === 'storage' ? 'active' : ''}">
      <div class="spinner"></div>
    </div>
    <div id="admin-ops-panel" class="sub-panel ${state.adminTab === 'ops' ? 'active' : ''}">
      <div class="spinner"></div>
    </div>
    <div id="admin-index-panel" class="sub-panel ${state.adminTab === 'index' ? 'active' : ''}">
      <div class="spinner"></div>
    </div>
  `;
  if (state.adminTab === 'storage')   await loadAdminStoragePanel();
  else if (state.adminTab === 'ops')  await loadAdminOpsPanel();
  else                                await loadAdminIndexPanel();
}

function switchAdminTab(tab) {
  state.adminTab = tab;
  document.querySelectorAll('[data-admin-tab]').forEach(b => {
    b.classList.toggle('active', b.dataset.adminTab === tab);
  });
  const storagePanel = document.getElementById('admin-storage-panel');
  const opsPanel     = document.getElementById('admin-ops-panel');
  const indexPanel   = document.getElementById('admin-index-panel');
  if (storagePanel) storagePanel.classList.toggle('active', tab === 'storage');
  if (opsPanel)     opsPanel.classList.toggle('active', tab === 'ops');
  if (indexPanel)   indexPanel.classList.toggle('active', tab === 'index');
  if (tab === 'storage')  loadAdminStoragePanel();
  else if (tab === 'ops') loadAdminOpsPanel();
  else                    loadAdminIndexPanel();
}

// ── Admin storage panel ───────────────────────────────────────────────────────
async function loadAdminStoragePanel() {
  const panel = document.getElementById('admin-storage-panel');
  if (!panel) return;
  panel.innerHTML = `
    <div class="section">
      <div class="section-header"><span class="section-title">SCHEMA MANAGEMENT</span></div>
      <div class="admin-actions">
        <button class="btn btn-ghost" onclick="adminImportSchema()">⬆ Import Schema</button>
      </div>
      <input type="file" id="admin-import-file" accept=".json,application/json" style="display:none"
             onchange="adminImportSchemaFile(this)">
    </div>
    <div class="section">
      <div class="section-header"><span class="section-title">ACTIONS</span></div>
      <div class="admin-actions">
        <button class="btn btn-ghost" onclick="adminTriggerGc()">⚡ Trigger GC</button>
        <button class="btn btn-ghost" onclick="adminTriggerWalGc()">⚡ Trigger WAL GC</button>
        <button class="btn btn-ghost" onclick="adminCompact()">⚡ Compact LSM</button>
        <button class="btn btn-ghost" onclick="adminIndexCheckpoint(this)"
                title="Flush and compact field indices in the background — only one run at a time">⚡ Index Checkpoint</button>
        <button class="btn btn-danger" onclick="adminClearQueryCache()">🗑 Clear Query Cache</button>
        <button class="btn btn-secondary" style="margin-left:auto" onclick="adminRefresh()">↻ Refresh Stats</button>
      </div>
      <div id="admin-action-result"></div>
    </div>
    <div id="admin-storage-stats"><div class="spinner"></div></div>
  `;
  await loadStorageStats();
}

// ── Admin ops-metrics panel ─────────────────────────────────────────────────────
async function loadAdminOpsPanel() {
  const panel = document.getElementById('admin-ops-panel');
  if (!panel) return;
  panel.innerHTML = `
    <div class="section">
      <div class="section-header"><span class="section-title">ACTIONS</span></div>
      <div class="admin-actions">
        <button class="btn btn-secondary" onclick="loadOpsMetrics()">↻ Refresh Metrics</button>
      </div>
      <div class="text-muted" style="font-size:12px;margin-top:6px">
        Counters are cumulative since startup, in-memory only — reset to zero on restart
        (some are repopulated by recovery work on the way up). Sample twice to compute
        rates. Hover any label for what it measures.
      </div>
    </div>

    <div class="ops-metrics-cols">
      <div class="ops-metrics-col">
        <div class="section-header" style="margin-top:4px">
          <span class="section-title">ENGINE-WIDE</span>
        </div>
        <div class="text-muted" style="font-size:12px;margin-bottom:8px">
          Sum of every namespace plus engine-global WAL-GC and retired-namespace totals.
        </div>
        <div id="admin-ops-metrics"><div class="spinner"></div></div>
      </div>

      <div class="ops-metrics-col">
        <div class="section-header" style="margin-top:4px">
          <span class="section-title">PER-NAMESPACE</span>
          <select id="ops-ns-select" style="max-width:320px"
                  onchange="onOpsNsChange()"></select>
        </div>
        <div class="text-muted" style="font-size:12px;margin-bottom:8px">
          Counters for the selected namespace. WAL-GC is engine-global (not attributable to a
          namespace) and is shown in the engine-wide panel beside this one.
        </div>
        <div id="admin-ops-metrics-ns"><div class="spinner"></div></div>
      </div>
    </div>
  `;
  await loadOpsMetrics();
}

async function loadOpsMetrics() {
  const engineArea = document.getElementById('admin-ops-metrics');
  const nsArea     = document.getElementById('admin-ops-metrics-ns');
  if (engineArea) engineArea.innerHTML = '<div class="spinner"></div>';
  if (nsArea)     nsArea.innerHTML     = '<div class="spinner"></div>';

  const [engineRes, nsRes] = await Promise.allSettled([
    Api.opsMetrics(),
    Api.opsMetricsByNamespace(),
  ]);

  if (engineArea) {
    engineArea.innerHTML = engineRes.status === 'fulfilled'
      ? renderOpsMetricsHtml(engineRes.value)
      : `<div class="alert alert-error">Failed to load engine ops metrics: ${esc(engineRes.reason?.message)}</div>`;
  }

  if (nsRes.status === 'fulfilled') {
    state.opsByNamespace = nsRes.value ?? [];
    renderOpsNsSelect();
  } else if (nsArea) {
    state.opsByNamespace = [];
    nsArea.innerHTML = `<div class="alert alert-error">Failed to load per-namespace ops metrics: ${esc(nsRes.reason?.message)}</div>`;
  }
}

// Populate the namespace dropdown from the cached by-namespace data, preserving
// the current selection where possible, then render the selected namespace.
// Only user-facing namespaces (the user's own doc/kv stores) are listed —
// internal/engine namespaces are filtered out.
function renderOpsNsSelect() {
  const sel = document.getElementById('ops-ns-select');
  if (!sel) return;
  const userNs = new Set([...state.stores, ...state.kvStores].map(s => s.namespace));
  const names = state.opsByNamespace
    .map(e => e.namespace)
    .filter(n => userNs.has(n))
    .sort((a, b) => a.localeCompare(b));
  if (!names.length) {
    sel.innerHTML = '';
    const nsArea = document.getElementById('admin-ops-metrics-ns');
    if (nsArea) nsArea.innerHTML = '<div class="text-muted" style="font-size:13px">No namespaces yet.</div>';
    return;
  }
  if (!names.includes(state.opsSelectedNs)) {
    state.opsSelectedNs = names[0];
  }
  sel.innerHTML = names.map(n =>
    `<option value="${esc(n)}" ${n === state.opsSelectedNs ? 'selected' : ''}>${esc(n)}</option>`
  ).join('');
  renderOpsNsMetrics();
}

function onOpsNsChange() {
  const sel = document.getElementById('ops-ns-select');
  if (!sel) return;
  state.opsSelectedNs = sel.value;
  renderOpsNsMetrics();
}

function renderOpsNsMetrics() {
  const nsArea = document.getElementById('admin-ops-metrics-ns');
  if (!nsArea) return;
  const entry = state.opsByNamespace.find(e => e.namespace === state.opsSelectedNs);
  nsArea.innerHTML = entry
    ? renderOpsMetricsHtml(entry, { perNamespace: true })
    : '<div class="text-muted" style="font-size:13px">Select a namespace.</div>';
}

function renderOpsMetricsHtml(m, opts = {}) {
  const perNs = opts.perNamespace === true;
  const r = m.reads ?? {}, l = m.lsm_lookups ?? {}, w = m.writes ?? {},
        c = m.compaction ?? {}, g = m.gc ?? {};

  const ratioPct = (x) => `${((x ?? 0) * 100).toFixed(1)}%`;
  const ratioCls = (x, warnBelow) => (x ?? 0) >= warnBelow ? 'good' : (x ?? 0) >= warnBelow * 0.6 ? 'warn' : 'bad';
  const row = (k, v, cls, tip) => `<div class="stat-row"><span class="stat-key"${tip ? ` title="${esc(tip)}"` : ''}>${k}</span>
    <span class="stat-val ${cls ?? ''}">${v}</span></div>`;
  const bar = (ratio, label) => `
    <div style="margin:6px 0 10px">
      <div class="progress-wrap" style="height:10px">
        <div class="progress-bar" style="width:${Math.min((ratio ?? 0) * 100, 100)}%;
             background:${(ratio ?? 0) >= 0.8 ? 'var(--success)' : (ratio ?? 0) >= 0.5 ? 'var(--warning)' : 'var(--error)'}">
        </div>
      </div>
      <div class="progress-label">${label}</div>
    </div>`;

  const apFailCls = (w.apply_failures ?? 0) > 0 ? 'bad' : 'good';

  return `
    <div class="admin-grid">
      <div class="admin-card">
        <div class="admin-card-title" title="User-facing read path. In-memory counters, reset to zero on restart.">READS</div>
        ${bar(r.read_hit_ratio, `${ratioPct(r.read_hit_ratio)} hit ratio`)}
        ${row('Reads', fmt(r.reads), '', 'User-facing point reads (GET by key) since startup.')}
        ${row('Hits', fmt(r.read_hits), 'good', 'Reads that found a live value.')}
        ${row('Misses', fmt(r.read_misses), (r.read_misses ?? 0) > 0 ? 'warn' : '', 'Reads that found nothing — absent or tombstoned key.')}
        ${row('Hit Ratio', ratioPct(r.read_hit_ratio), ratioCls(r.read_hit_ratio, 0.8), 'Hits / Reads.')}
        ${row('Scans', fmt(r.scans), '', 'Multi-key scans (range / prefix) executed.')}
        ${row('Scan Rows', fmt(r.scan_rows), '', 'Total rows returned across all scans.')}
      </div>

      <div class="admin-card">
        <div class="admin-card-title" title="Internal LSM-tree probes behind the read path. In-memory, reset on restart.">LSM LOOKUPS</div>
        ${bar(l.fast_path_hit_ratio, `${ratioPct(l.fast_path_hit_ratio)} fast-path`)}
        ${row('Lookups', fmt(l.lookups), '', 'LSM point lookups. ≥ Reads — also counts GC-validation reads and WAL-replay probes (so it jumps after a restart).')}
        ${row('Fast-path Hits', fmt(l.fast_path_hits), 'good', 'Lookups served by the active memtable without scanning lower layers.')}
        ${row('Fast-path Ratio', ratioPct(l.fast_path_hit_ratio), ratioCls(l.fast_path_hit_ratio, 0.5), 'Fast-path Hits / Lookups.')}
        ${row('L0 Probes', fmt(l.l0_probes), '', 'Lookups that scanned at least one L0 SSTable.')}
        ${row('L1 Probes', fmt(l.l1_probes), '', 'Lookups that scanned the L1 SSTable (not skipped by the bloom filter or by seq).')}
        ${row('Bloom Rejects', fmt(l.bloom_rejects), '', 'L1 lookups short-circuited by the bloom filter ("definitely absent") — work avoided.')}
        ${row('L0 Bloom Rejects', fmt(l.l0_bloom_rejects), '', 'L0 files a lookup skipped without reading: the key is outside the file\'s key range, or its bloom filter says "definitely absent" — work avoided.')}
        ${row('Seq Prunes', fmt(l.seq_prunes), '', 'SSTables (L0 files or the L1 file) a lookup skipped without reading because a newer layer already held a copy at least as new as anything in them — work avoided.')}
        ${row('Sparse Hint Rejects', fmt(l.sparse_hint_rejects), (l.sparse_hint_rejects ?? 0) > 0 ? 'warn' : '', 'Lookups whose sparse-index hint failed validation, so the scan restarted from the top of the file. Answers stay correct, only slower. A few are expected briefly for L1 during a compaction; a steady climb means the index offsets are wrong.')}
      </div>

      <div class="admin-card">
        <div class="admin-card-title" title="Write path throughput and durability cost. In-memory, reset on restart.">WRITES</div>
        ${row('Puts', fmt(w.puts), '', 'WAL-backed upserts applied.')}
        ${row('Deletes', fmt(w.deletes), '', 'WAL-backed deletes applied.')}
        ${row('No-WAL Puts', fmt(w.no_wal_puts), '', 'Upserts written bypassing the WAL (skip_wal path — e.g. vector payloads, query-embedding cache).')}
        ${row('No-WAL Deletes', fmt(w.no_wal_deletes), '', 'Deletes written bypassing the WAL (skip_wal path — e.g. query-embedding cache populate/clear).')}
        ${row('WAL Appended', fmtBytes(w.wal_bytes_appended), '', 'Total bytes appended to the WAL.')}
        ${row('WAL Fsyncs', fmt(w.wal_fsyncs), '', 'WAL fsyncs — one per WAL-backed write. The durability cost of writes.')}
        ${row('Apply Failures', fmt(w.apply_failures), apFailCls, 'In-memory applies that failed after retry. Data is still durable in the WAL.')}
      </div>

      <div class="admin-card">
        <div class="admin-card-title" title="LSM memtable flushes and level compactions. In-memory, reset on restart.">COMPACTION</div>
        ${row('Memtable Flushes', fmt(c.memtable_flushes), '', 'Memtable → L0 SSTable flushes.')}
        ${row('L0→L1 Compactions', fmt(c.l0_l1_compactions), '', 'L0 → L1 compactions run.')}
        ${row('Bytes Merged', fmtBytes(c.compaction_bytes_merged), '', 'Total bytes merged during compactions.')}
        ${row('Duration', fmtMillis(c.compaction_duration_ms), '', 'Cumulative time spent compacting.')}
      </div>

      <div class="admin-card">
        <div class="admin-card-title" title="Value-log and WAL space reclamation. In-memory, reset on restart.">GARBAGE COLLECTION</div>
        ${row('VLog GC Runs', fmt(g.vlog_gc_runs), '', 'Value-log GC passes run.')}
        ${row('VLog GC Duration', fmtMillis(g.vlog_gc_duration_ms), '', 'Cumulative value-log GC time.')}
        ${row('VLog Segments Reclaimed', fmt(g.vlog_segments_reclaimed), '', 'Value-log segment files unlinked whole by GC.')}
        ${row('VLog Bytes Reclaimed', fmtBytes(g.vlog_gc_bytes_reclaimed), '', 'Bytes handed back to the filesystem by unlinking those segments.')}
        ${row('VLog Bytes Rewritten', fmtBytes(g.vlog_gc_bytes_rewritten), '', 'Bytes of survivors GC rewrote to relocate them out of the segments it collected — the cost of the work.')}
        ${row('VLog Write Amp', fmtWriteAmp(g.vlog_gc_write_amplification), writeAmpClass(g.vlog_gc_write_amplification),
              'Rewritten / reclaimed. Well below 1× is healthy — GC frees far more than it rewrites. Above 1× it is relocating more data than it frees (the segments it picks are mostly survivors); page_gc_threshold is the knob. Blank until GC has reclaimed anything.')}
        ${perNs
          ? `<div class="stat-row text-muted" style="font-size:12px"><span>WAL GC is engine-global — see the engine-wide panel.</span></div>`
          : `${row('WAL GC Runs', fmt(g.wal_gc_runs), '', 'WAL GC passes run.')}
        ${row('WAL Segments Deleted', fmt(g.wal_segments_deleted), '', 'WAL segments reclaimed by GC.')}`}
      </div>

      ${perNs ? '' : `<div class="admin-card">
        <div class="admin-card-title">UPTIME</div>
        ${row('Since Startup', fmtUptime(m.uptime_s), '', 'Seconds since the server process started.')}
      </div>`}
    </div>
  `;
}

function fmtMillis(ms) {
  if (ms == null) return '—';
  if (ms < 1000)        return `${fmt(ms)} ms`;
  if (ms < 60000)       return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

// GC write amplification: bytes rewritten per byte reclaimed. Null until GC has
// reclaimed anything, so it stays blank rather than reading as a healthy 0×.
function fmtWriteAmp(x) {
  return x == null ? '—' : `${x.toFixed(2)}×`;
}

// At 1× GC rewrites as much as it frees — it is treading water. Flag before that.
function writeAmpClass(x) {
  if (x == null) return '';
  return x >= 1 ? 'bad' : x >= 0.5 ? 'warn' : 'good';
}

// The WAL is a sequence of segment files. Expandable, like value-log shards: each
// row is one segment file and its entry backlog. Pending entries are what a restart
// would replay, so a segment carrying pending entries is one the LSM has not caught
// up with yet; fully-persisted segments below the live window are what WAL GC unlinks.
function renderWalSegments(segments) {
  segments = segments ?? [];
  if (!segments.length) return '';

  const rows = segments.map(s => {
    const pc = s.pending_entries > 0 ? 'warn' : 'good';
    return `
      <div class="vlog-seg" title="${fmt(s.total_entries)} entries — ${fmt(s.persisted_entries)} persisted to the LSM, ${fmt(s.pending_entries)} would be replayed on the next open">
        <span class="vlog-seg-id">seg ${fmt(s.segment_id)}</span>
        <span class="stat-val">${fmt(s.total_entries)} entries</span>
        <span class="stat-val good">${fmt(s.persisted_entries)} persisted</span>
        <span class="stat-val ${pc}">${fmt(s.pending_entries)} pending</span>
      </div>`;
  }).join('');

  return `
    <div style="margin-top:8px">
      <div class="vlog-shard-head" onclick="toggleVlogShard('wal-segs', this)"
           title="Every WAL segment file currently tracked.">
        <span class="vlog-caret">▸</span>
        <span class="stat-key">Segments</span>
        <span class="stat-val">${fmt(segments.length)} file${segments.length === 1 ? '' : 's'}</span>
      </div>
      <div class="vlog-seg-list" id="wal-segs" style="display:none">${rows}</div>
    </div>`;
}

async function loadStorageStats() {
  const area = document.getElementById('admin-storage-stats');
  if (!area) return;
  try {
    const [h, s, w, sys, lsmArr, vlogArr] = await Promise.all([
      Api.health(), Api.stats(), Api.wal(), Api.systemStores(), Api.lsm(),
      Api.valueLog().catch(() => null),
    ]);
    state.adminStats = s; state.adminWal = w;
    state.adminLsm  = Object.fromEntries((lsmArr  ?? []).map(x => [x.namespace, x]));
    state.adminVlog = Object.fromEntries((vlogArr ?? []).map(x => [x.namespace, x]));
    state.adminSys  = sys;

    const rowCountResults = await Promise.allSettled(
      state.stores.map(ds => Api.storeRowCount(ds.namespace))
    );
    state.adminRowCounts = Object.fromEntries(
      state.stores.map((ds, i) => [
        ds.namespace,
        rowCountResults[i].status === 'fulfilled' ? rowCountResults[i].value?.count : null,
      ])
    );

    const wasteClass = s.waste_ratio_pct > 40 ? 'bad' : s.waste_ratio_pct > 20 ? 'warn' : 'good';
    const pendClass  = w.pending_entries > 1000 ? 'warn' : 'good';

    area.innerHTML = `
      <div class="admin-grid">
        <div class="admin-card">
          <div class="admin-card-title">SERVER</div>
          <div class="stat-row"><span class="stat-key">Status</span>
            <span class="stat-val good">${esc(h.status)}</span></div>
          <div class="stat-row"><span class="stat-key">Uptime</span>
            <span class="stat-val">${fmtUptime(h.uptime_s)}</span></div>
          <div class="stat-row"><span class="stat-key">Base URL</span>
            <span class="stat-val" style="font-size:12px">${esc(state.baseUrl)}</span></div>
        </div>

        <div class="admin-card">
          <div class="admin-card-title" title="Value-log aggregate across every namespace, recomputed from on-disk state on every request — survives restart.">STORAGE STATS</div>
          <div class="stat-row"><span class="stat-key" title="Live (non-garbage) bytes in the value log.">Live Data</span>
            <span class="stat-val">${fmtBytes(s.live_bytes)}</span></div>
          <div class="stat-row"><span class="stat-key" title="Reclaimable dead bytes across the value log (superseded or deleted records awaiting GC).">Garbage</span>
            <span class="stat-val ${wasteClass}">${fmtBytes(s.garbage_bytes)}</span></div>
          <div class="stat-row"><span class="stat-key" title="Dead / total written. High = value-log GC is overdue.">Waste Ratio</span>
            <span class="stat-val ${wasteClass}">${s.waste_ratio_pct.toFixed(1)}%</span></div>
          ${s.segment_count != null ? `
          <div class="stat-row"><span class="stat-key" title="Value-log segment files on disk across every namespace.">Segment Files</span>
            <span class="stat-val">${fmt(s.segment_count)}${s.namespaces != null ? ` <span class="text-muted" style="font-size:11px">across ${fmt(s.namespaces)} ns</span>` : ''}</span></div>` : ''}
          ${s.disk_bytes != null ? `
          <div class="stat-row"><span class="stat-key" title="Bytes those segment files occupy on disk.">On-disk</span>
            <span class="stat-val">${fmtBytes(s.disk_bytes)}</span></div>` : ''}
          <div class="stat-row"><span class="stat-key" title="Value-log GC passes ever run (persisted in metadata).">GC Runs</span>
            <span class="stat-val">${fmt(s.total_gc_runs)}</span></div>
          <div class="stat-row"><span class="stat-key" title="Bytes ever reclaimed by value-log GC (persisted).">Bytes Reclaimed</span>
            <span class="stat-val">${fmtBytes(s.total_bytes_reclaimed)}</span></div>
        </div>

        <div class="admin-card">
          <div class="admin-card-title" title="Write-ahead log metadata, read from on-disk state — survives restart.">WAL</div>
          <div class="stat-row"><span class="stat-key" title="Entries currently tracked in the WAL.">Total Entries</span>
            <span class="stat-val">${fmt(w.total_entries)}</span></div>
          <div class="stat-row"><span class="stat-key" title="Entries already applied and persisted to the LSM tree.">Persisted</span>
            <span class="stat-val good">${fmt(w.persisted_entries)}</span></div>
          <div class="stat-row"><span class="stat-key" title="Total − Persisted. Entries that would be replayed on the next open. A large backlog hints at flush lag.">Pending</span>
            <span class="stat-val ${pendClass}">${fmt(w.pending_entries)}</span></div>
          <div class="stat-row"><span class="stat-key" title="WAL GC passes ever run (persisted).">GC Runs</span>
            <span class="stat-val">${fmt(w.total_gc_runs)}</span></div>
          <div class="stat-row"><span class="stat-key" title="Bytes ever reclaimed by WAL GC (persisted).">Bytes Reclaimed</span>
            <span class="stat-val">${fmtBytes(w.total_bytes_reclaimed)}</span></div>
          ${w.live_segments != null ? `
          <div class="stat-row"><span class="stat-key" title="Tracked WAL segments still carrying entries (lower segments have been trimmed).">Live Segments</span>
            <span class="stat-val">${fmt(w.live_segments)}${w.base_segment_id != null ? ` <span class="text-muted" style="font-size:11px">from #${fmt(w.base_segment_id)}</span>` : ''}</span></div>` : ''}
          ${w.last_sequence != null ? `
          <div class="stat-row"><span class="stat-key" title="Highest write sequence number the WAL has observed.">Last Sequence</span>
            <span class="stat-val">${fmt(w.last_sequence)}</span></div>` : ''}
          <div class="stat-row"><span class="stat-key" title="WAL byte offsets of the live window (start → end).">Head → Tail</span>
            <span class="stat-val" style="font-size:11px">${fmt(w.head)} → ${fmt(w.tail)}</span></div>
          ${renderWalSegments(w.segments)}
        </div>
      </div>

      <div class="section">
        <div class="section-header"><span class="section-title">OVERALL WASTE RATIO</span></div>
        <div class="progress-wrap" style="height:12px">
          <div class="progress-bar" style="width:${Math.min(s.waste_ratio_pct,100)}%;
               background:${s.waste_ratio_pct>40?'var(--error)':s.waste_ratio_pct>20?'var(--warning)':'var(--success)'}">
          </div>
        </div>
        <div class="progress-label">${s.waste_ratio_pct.toFixed(1)}% garbage</div>
      </div>

      <div id="storage-stores-section">${renderStorageStoresTabs()}</div>
    `;
    renderStorageNsSelect();
  } catch (e) {
    area.innerHTML = `<div class="alert alert-error">Failed to load stats: ${esc(e.message)}</div>`;
  }
}

// ── Namespaces section (tabbed) ─────────────────────────────────────────────────
// One tab per store category (Doc / KV / System). Each tab has a namespace
// dropdown (like the per-namespace ops panel) and shows the storage metrics for
// the single selected namespace, rather than listing every namespace at once.

// Build the list of selectable namespaces for a tab. Each entry carries the
// info its summary header needs plus a `kind` that decides which meta endpoint
// and renderer the detail uses.
function storageTabEntries(tab) {
  if (tab === 'doc') {
    return state.stores.map(s => ({ key: s.namespace, name: s.namespace, kind: 'doc', store: s }));
  }
  if (tab === 'kv') {
    return state.kvStores.map(s => ({ key: s.namespace, name: s.namespace, kind: 'kv', store: s }));
  }
  // system: kv system stores first, then doc system stores
  const sys = state.adminSys ?? {};
  return [
    ...(sys.kv_stores  ?? []).map(k => ({ key: `kv:${k.name}`,      name: k.name,      kind: 'sys-kv',  store: k })),
    ...(sys.doc_stores ?? []).map(d => ({ key: `doc:${d.namespace}`, name: d.namespace, kind: 'sys-doc', store: d })),
  ];
}

const STORAGE_TAB_LABELS = { doc: 'DOC STORE', kv: 'KV STORE', system: 'SYSTEM' };

function renderStorageStoresTabs() {
  const sys   = state.adminSys ?? {};
  const sysN  = (sys.kv_stores?.length ?? 0) + (sys.doc_stores?.length ?? 0);
  const counts = { doc: state.stores.length, kv: state.kvStores.length, system: sysN };
  const tab   = state.storageStoresTab;
  const btn   = (t, label) => `
    <button class="sub-tab-btn ${tab === t ? 'active' : ''}"
            onclick="switchStorageStoresTab('${t}')">${label} (${counts[t]})</button>`;
  return `
    <div class="section">
      <div class="sub-tab-nav" style="margin-bottom:14px">
        ${btn('doc', 'Doc Stores')}
        ${btn('kv', 'KV Stores')}
        ${btn('system', 'System')}
      </div>
      <div class="section-header">
        <span class="section-title">${STORAGE_TAB_LABELS[tab]} NAMESPACES</span>
        <select id="storage-ns-select" style="max-width:320px"
                onchange="onStorageNsChange()"></select>
      </div>
      <div id="storage-ns-detail"><div class="spinner"></div></div>
    </div>
  `;
}

function switchStorageStoresTab(tab) {
  state.storageStoresTab = tab;
  const section = document.getElementById('storage-stores-section');
  if (!section) return;
  section.innerHTML = renderStorageStoresTabs();
  renderStorageNsSelect();
}

// Populate the dropdown for the active tab, preserving the current selection
// where possible, then render the selected namespace's detail.
function renderStorageNsSelect() {
  const sel = document.getElementById('storage-ns-select');
  if (!sel) return;
  const tab     = state.storageStoresTab;
  const entries = storageTabEntries(tab);
  const detail  = document.getElementById('storage-ns-detail');
  if (!entries.length) {
    sel.innerHTML = '';
    sel.style.display = 'none';
    if (detail) detail.innerHTML =
      `<div class="text-muted" style="padding:12px 0">No ${STORAGE_TAB_LABELS[tab].toLowerCase()} namespaces found.</div>`;
    return;
  }
  sel.style.display = '';
  if (!entries.some(e => e.key === state.storageSelectedNs[tab])) {
    state.storageSelectedNs[tab] = entries[0].key;
  }
  sel.innerHTML = entries.map(e =>
    `<option value="${esc(e.key)}" ${e.key === state.storageSelectedNs[tab] ? 'selected' : ''}>${esc(e.name)}</option>`
  ).join('');
  renderStorageNsDetail();
}

function onStorageNsChange() {
  const sel = document.getElementById('storage-ns-select');
  if (!sel) return;
  state.storageSelectedNs[state.storageStoresTab] = sel.value;
  renderStorageNsDetail();
}

function renderStorageNsDetail() {
  const area = document.getElementById('storage-ns-detail');
  if (!area) return;
  const tab     = state.storageStoresTab;
  const entry   = storageTabEntries(tab).find(e => e.key === state.storageSelectedNs[tab]);
  if (!entry) {
    area.innerHTML = '<div class="text-muted" style="padding:12px 0">Select a namespace.</div>';
    return;
  }
  const needsMeta = entry.kind !== 'sys-doc';
  area.innerHTML = `
    ${renderStorageEntrySummary(entry)}
    ${needsMeta ? '<div id="storage-ns-meta"><div class="spinner" style="margin:12px 0"></div></div>' : ''}
  `;
  if (needsMeta) loadStorageEntryMeta(entry);
}

// The summary header card for a selected namespace, mirroring the header row that
// used to appear in each per-category list.
function renderStorageEntrySummary(entry) {
  const { kind, store } = entry;
  const lsm = state.adminLsm?.[entry.name];
  const entryCount = lsm ? fmt(lsm.total_entries) : '—';
  const diskSize   = lsm ? fmtBytes(lsm.total_size_bytes) : '—';

  if (kind === 'doc') {
    const rowCount = state.adminRowCounts?.[entry.name];
    const nsEsc = esc(entry.name);
    return `
      <div class="sys-store-row">
        <div class="sys-store-header">
          <div class="sys-store-identity">
            <span class="sys-store-name">${nsEsc}</span>
            ${keyTypeBadge(store.key_type)}
            ${lsmCompactionBadge(lsm)}
          </div>
          <div class="sys-store-meta">
            <span class="stat-key">Rows</span>
            <span class="stat-val">${rowCount != null ? fmt(rowCount) : '—'}</span>
            <span class="stat-key" style="margin-left:12px">LSM Entries</span>
            <span class="stat-val">${entryCount}</span>
            <span class="stat-key" style="margin-left:12px">On-disk</span>
            <span class="stat-val">${diskSize}</span>
            <button class="btn btn-sm btn-ghost"
                    onclick="adminExportSchema('${nsEsc}')">⬇ Export</button>
          </div>
        </div>
      </div>`;
  }

  if (kind === 'kv') {
    return `
      <div class="sys-store-row">
        <div class="sys-store-header">
          <div class="sys-store-identity">
            <span class="sys-store-name">${esc(entry.name)}</span>
            <span class="badge badge-kv">KV</span>
            ${keyTypeBadge(store.key_type)}
            ${kvValueTypeBadge(store.value_type)}
            ${store.semantic_search_enabled
              ? '<span class="badge badge-indexed">✨ Semantic ON</span>' : ''}
            ${lsmCompactionBadge(lsm)}
          </div>
          <div class="sys-store-meta">
            ${store.ns_id != null
              ? `<span class="stat-key">NS ID</span>
                 <span class="stat-val" style="font-size:11px">#${store.ns_id}</span>` : ''}
            <span class="stat-key" style="margin-left:12px">LSM Entries</span>
            <span class="stat-val">${entryCount}</span>
            <span class="stat-key" style="margin-left:12px">On-disk</span>
            <span class="stat-val">${diskSize}</span>
          </div>
        </div>
      </div>`;
  }

  if (kind === 'sys-kv') {
    return `
      <div class="sys-store-row">
        <div class="sys-store-header">
          <div class="sys-store-identity">
            <span class="sys-store-name">${esc(store.name)}</span>
            <span class="badge badge-attr">KV</span>
            ${store.ttl_enabled
              ? `<span class="badge badge-indexed">TTL ${fmtDuration(store.ttl_secs)}</span>${store.ttl_max_deletes_per_run != null ? `<span class="badge badge-attr">max ${fmt(store.ttl_max_deletes_per_run)}/run</span>` : ''}`
              : ''}
            <span class="sys-store-purpose">${esc(store.purpose)}</span>
          </div>
          <div class="sys-store-meta">
            <span class="stat-key">NS ID</span>
            <span class="stat-val" style="font-size:11px">#${store.ns_id}</span>
            <span class="stat-key" style="margin-left:12px">LSM Entries</span>
            <span class="stat-val">${fmt(store.lsm_entry_count)}</span>
          </div>
        </div>
      </div>`;
  }

  // sys-doc — no per-store meta endpoint, so the summary is the whole view
  return `
    <div class="sys-store-row">
      <div class="sys-store-header">
        <div class="sys-store-identity">
          <span class="sys-store-name">${esc(store.namespace)}</span>
          <span class="badge badge-uuid">Doc</span>
          ${store.semantic_search_enabled
            ? '<span class="badge badge-indexed">✨ Semantic ON</span>' : ''}
        </div>
        <div class="sys-store-meta">
          <span class="stat-key">NS ID</span>
          <span class="stat-val" style="font-size:11px">#${store.ns_id}</span>
        </div>
      </div>
    </div>
    <div class="alert alert-info" style="margin-top:8px">
      This system doc store exposes no per-namespace storage metrics.
    </div>`;
}

// Load and render the LSM/value-log detail for the selected namespace into
// #storage-ns-meta. Dispatches endpoint + renderer by kind.
async function loadStorageEntryMeta(entry) {
  const meta = document.getElementById('storage-ns-meta');
  if (!meta) return;
  try {
    let m, html;
    if (entry.kind === 'sys-kv') {
      m = await Api.systemStoreMeta(entry.name);
      graftStorageMeta(m);
      html = renderSystemStoreMeta(m);
    } else {
      m = await Api.storeKvMeta(entry.name);
      graftStorageMeta(m);
      html = entry.kind === 'doc' ? renderDocStoreKvMeta(m) : renderSystemStoreMeta(m);
    }
    // Guard against a race where the selection changed while the request was in flight.
    if (document.getElementById('storage-ns-meta') !== meta) return;
    meta.innerHTML = html;
  } catch (e) {
    if (e.message.includes('404') || e.message.toLowerCase().includes('not been opened')) {
      meta.innerHTML = `
        <div class="alert alert-info" style="margin-top:8px">
          This store has not been opened yet — it is created on first use
          (e.g. after the first semantic-search query).
        </div>`;
    } else {
      meta.innerHTML = `<div class="alert alert-error" style="margin-top:8px">${esc(e.message)}</div>`;
    }
  }
}

// ── Field-index waste ───────────────────────────────────────────────────────────
// Per-field reclaimable dead space in the field-index bitmap/keymap stores.
// Use it to decide whether to force an Index Checkpoint.
function renderIndexWasteSection(waste) {
  if (!waste) return '';
  const namespaces = (waste.namespaces ?? []).filter(n => (n.fields ?? []).length);
  const threshold  = waste.threshold ?? 0;
  const thresholdPct = (threshold * 100).toFixed(0);

  const overCount = namespaces.reduce(
    (acc, n) => acc + n.fields.filter(f => f.over_threshold).length, 0);

  const wasteCell = (ratio) => {
    if (ratio == null) return '<span class="stat-val text-muted">—</span>';
    const pct = ratio * 100;
    const cls = ratio >= threshold ? 'bad' : pct >= threshold * 50 ? 'warn' : 'good';
    return `<span class="stat-val ${cls}">${pct.toFixed(1)}%</span>`;
  };

  const nsBlocks = namespaces.map(n => {
    const fieldRows = n.fields.map(f => `
      <div class="stat-row index-waste-row${f.over_threshold ? ' over-threshold' : ''}">
        <span class="stat-key">
          ${esc(f.field_name)}
          <span class="badge badge-attr">${esc(f.field_type)}</span>
          ${f.over_threshold ? '<span class="badge badge-error">over threshold</span>' : ''}
        </span>
        <span class="sys-store-meta">
          <span class="stat-key" title="Reclaimable fraction of the bitmap blob store (one blob per distinct value, re-appended on every write). Grows with per-document churn.">bitmap</span> ${wasteCell(f.bitmap_waste_ratio)}
          <span class="stat-key" style="margin-left:12px" title="Reclaimable fraction of the keymap blob store (slot → value). Grows under distinct-value churn.">keymap</span> ${wasteCell(f.keymap_waste_ratio)}
          ${f.distinct_count != null
            ? `<span class="stat-key" style="margin-left:12px" title="Distinct indexed values for this field.">distinct</span>
               <span class="stat-val">${fmt(f.distinct_count)}</span>` : ''}
        </span>
      </div>`).join('');
    return `
      <div class="sys-store-row">
        <div class="sys-store-header">
          <div class="sys-store-identity">
            <span class="sys-store-name">${esc(n.namespace)}</span>
            <span class="stat-key">NS ID</span>
            <span class="stat-val" style="font-size:11px">#${n.ns_id}</span>
          </div>
        </div>
        <div style="padding:4px 0 8px">${fieldRows}</div>
      </div>`;
  }).join('');

  return `
    <div class="section">
      <div class="section-header">
        <span class="section-title">FIELD INDEX WASTE</span>
        <span class="text-muted" style="font-size:12px">
          fleet-wide ratios · compaction threshold ${thresholdPct}%${overCount
            ? ` · <span class="stat-val bad">${overCount} field${overCount !== 1 ? 's' : ''} over threshold</span> — run Index Checkpoint`
            : ' · all fields healthy'} · per-field byte detail in Index Management → Blob Stats
        </span>
      </div>
      <div class="sys-stores-list">
        ${namespaces.length
          ? nsBlocks
          : '<div class="text-muted" style="padding:12px 0">No indexed fields found</div>'}
      </div>
    </div>
  `;
}

// The per-store kv-meta endpoints omit data that only the engine-wide listings
// carry: the live in-memory LSM block (/admin/storage/lsm) and value-log physical
// st_blocks bytes (/admin/storage/value-log). Graft those onto a kv-meta payload
// from the snapshots cached in state during loadStorageStats so the Monitor card
// shows the full picture. No-op when a snapshot is missing.
function graftVlogPhysical(vlog) {
  if (!vlog) return;
  const src = state.adminVlog?.[vlog.namespace];
  if (!src) return;
  if (src.total_physical_bytes != null) vlog.total_physical_bytes = src.total_physical_bytes;
  const byBucket = Object.fromEntries((src.shards ?? []).map(s => [s.bucket, s]));
  for (const sh of vlog.shards ?? []) {
    const ss = byBucket[sh.bucket];
    if (ss) { sh.physical_bytes = ss.physical_bytes; sh.logical_bytes = ss.logical_bytes; }
  }
}

function graftLsmInMemory(lsm) {
  if (lsm) lsm.in_memory = state.adminLsm?.[lsm.namespace]?.in_memory ?? null;
}

function graftStorageMeta(m) {
  if (!m) return;
  graftLsmInMemory(m.lsm);
  graftVlogPhysical(m.value_log);
  for (const a of m.associated_stores ?? []) {
    graftLsmInMemory(a.lsm);
    graftVlogPhysical(a.value_log);
  }
}

// Inline LSM in-memory badge for compact store-row headers (active compaction).
function lsmCompactionBadge(lsm) {
  return lsm?.in_memory?.compaction_in_progress
    ? '<span class="badge badge-indexed">⚙ compacting</span>' : '';
}

// Unique DOM id per LSM card so the per-level shard tabs of multiple cards on the
// same page (system store + companion stores, etc.) don't collide.
let lsmCardSeq = 0;

// Switch the active level tab inside a single LSM card. Scoped by data-lsm-card so
// other LSM cards' tabs are untouched.
function switchLsmLevel(cardId, idx) {
  document.querySelectorAll(`.lsm-lvl-tab[data-lsm-card="${cardId}"]`).forEach(b =>
    b.classList.toggle('active', Number(b.dataset.lsmIdx) === idx));
  document.querySelectorAll(`.lsm-lvl-panel[data-lsm-card="${cardId}"]`).forEach(p =>
    p.classList.toggle('active', Number(p.dataset.lsmIdx) === idx));
}

function renderLsmCard(lsm) {
  if (!lsm) return `
    <div class="admin-card" style="flex:1">
      <div class="admin-card-title">LSM</div>
      <div class="text-muted">No SST files written yet</div>
    </div>`;

  const im = lsm.in_memory;
  const inMemoryHtml = im ? `
    <div class="admin-card-title" style="margin-top:10px;margin-bottom:4px">
      IN-MEMORY ${im.compaction_in_progress ? '<span class="badge badge-indexed">⚙ compacting</span>' : ''}
    </div>
    <div class="stat-row"><span class="stat-key">Memtable Entries</span>
      <span class="stat-val">${fmt(im.memtable_entries)}</span></div>
    <div class="stat-row"><span class="stat-key">Sealed Entries</span>
      <span class="stat-val">${fmt(im.read_only_entries)}</span></div>
    <div class="stat-row"><span class="stat-key">Sealed Memtables</span>
      <span class="stat-val ${im.read_only_count > 0 ? 'warn' : ''}">${fmt(im.read_only_count)}</span></div>
  ` : '';

  return `
    <div class="admin-card" style="flex:1">
      <div class="admin-card-title">LSM</div>
      <div class="stat-row"><span class="stat-key">Total Entries</span>
        <span class="stat-val">${fmt(lsm.total_entries)}</span></div>
      <div class="stat-row"><span class="stat-key">On-disk Size</span>
        <span class="stat-val">${fmtBytes(lsm.total_size_bytes)}</span></div>
      <div class="stat-row"><span class="stat-key">Levels</span>
        <span class="stat-val">${lsm.level_count}</span></div>
      <div class="stat-row"><span class="stat-key">Manifest Version</span>
        <span class="stat-val">${lsm.manifest_version}</span></div>
      <div class="stat-row"><span class="stat-key">Created</span>
        <span class="stat-val" style="font-size:11px">${new Date(lsm.created_at_ms).toLocaleString()}</span></div>
      ${inMemoryHtml}
      ${renderLsmLevelTabs(lsm.levels)}
    </div>`;
}

// Per-level (L0 / L1 / …) shard breakdown. Each level's buckets are the SSTable
// shards the manifest tracks; the /admin/storage LSM payload carries them but the
// summary card used to drop everything below the level aggregate. Stacked as tabs
// so a wide bucket count doesn't blow up the card height.
function renderLsmLevelTabs(levels) {
  levels = levels ?? [];
  if (!levels.length) return '';
  const cardId = `lsm-card-${++lsmCardSeq}`;

  const tabs = levels.map((lvl, i) => `
    <button class="lsm-lvl-tab ${i === 0 ? 'active' : ''}"
            data-lsm-card="${cardId}" data-lsm-idx="${i}"
            onclick="switchLsmLevel('${cardId}', ${i})"
            title="${lvl.bucket_count} shard(s), ${fmt(lvl.total_entries)} entries">L${lvl.level} · ${lvl.bucket_count}</button>
  `).join('');

  const panels = levels.map((lvl, i) => {
    const buckets = lvl.buckets ?? [];
    const rows = buckets.length ? buckets.map(b => {
      const files = b.files ?? [];
      const size = files.reduce((a, f) => a + (f.size_bytes || 0), 0);
      const fc = b.file_count ?? files.length;
      return `
        <div class="stat-row" title="${fc} SSTable file(s), ${fmtBytes(size)} on disk">
          <span class="stat-key">Shard ${b.bucket}</span>
          <span class="stat-val">${fmt(b.total_entries)} entries</span>
          <span class="stat-val" style="margin-left:8px">${fmtBytes(size)}</span>
          <span class="stat-val text-muted" style="margin-left:8px;font-size:11px">${fc} file${fc === 1 ? '' : 's'}</span>
        </div>`;
    }).join('') : '<div class="text-muted" style="font-size:11px;padding:4px 0">No shards at this level</div>';
    return `
      <div class="lsm-lvl-panel ${i === 0 ? 'active' : ''}" data-lsm-card="${cardId}" data-lsm-idx="${i}">
        ${rows}
      </div>`;
  }).join('');

  return `
    <div class="admin-card-title" style="margin-top:10px;margin-bottom:6px">SHARDS BY LEVEL</div>
    <div class="lsm-lvl-tabs">${tabs}</div>
    ${panels}`;
}

function renderVlogCard(vlog) {
  if (!vlog) return `
    <div class="admin-card" style="flex:1">
      <div class="admin-card-title">VALUE LOG</div>
      <div class="text-muted">No data written yet</div>
    </div>`;

  const wc = vlog.waste_ratio_pct > 40 ? 'bad' : vlog.waste_ratio_pct > 20 ? 'warn' : 'good';
  return `
    <div class="admin-card" style="flex:1">
      <div class="admin-card-title">VALUE LOG</div>
      <div class="stat-row"><span class="stat-key">Live Data</span>
        <span class="stat-val">${fmtBytes(vlog.total_live_bytes)}</span></div>
      <div class="stat-row"><span class="stat-key">Garbage</span>
        <span class="stat-val ${wc}">${fmtBytes(vlog.total_garbage_bytes)}</span></div>
      <div class="stat-row"><span class="stat-key">Waste Ratio</span>
        <span class="stat-val ${wc}">${vlog.waste_ratio_pct.toFixed(1)}%</span></div>
      ${vlog.total_physical_bytes != null ? `
      <div class="stat-row"><span class="stat-key" title="Blocks actually allocated on disk (st_blocks); sparse GC holes excluded">On-disk (physical)</span>
        <span class="stat-val">${fmtBytes(vlog.total_physical_bytes)}</span></div>` : ''}
      <div style="margin:8px 0 4px">
        <div class="progress-wrap">
          <div class="progress-bar" style="width:${Math.min(vlog.waste_ratio_pct,100)}%;
               background:${vlog.waste_ratio_pct>40?'var(--error)':vlog.waste_ratio_pct>20?'var(--warning)':'var(--success)'}">
          </div>
        </div>
      </div>
      ${renderVlogShards(vlog.shards)}
    </div>`;
}

// Unique DOM id per value-log card, so the per-shard segment panels of several
// cards on one page (store + its companion stores) don't collide.
let vlogCardSeq = 0;

// Shards, each expandable into the segment files it holds. A sharded value log is
// now n append-only segment files per shard: exactly one unsealed active tail
// (never collected) plus sealed segments, which are what GC selects from. The
// segment rows are what make an imminent GC legible — a sealed segment at 100%
// garbage is a file about to be unlinked whole.
function renderVlogShards(shards) {
  shards = shards ?? [];
  if (!shards.length) return '';
  const cardId = `vlog-card-${++vlogCardSeq}`;

  const rows = shards.map((sh, i) => {
    const sc = sh.waste_ratio_pct > 40 ? 'bad' : sh.waste_ratio_pct > 20 ? 'warn' : 'good';
    const panelId = `${cardId}-shard-${i}`;
    const segs = sh.segments ?? [];
    // segment_count is authoritative; segments[] is the breakdown of the same files.
    const n = sh.segment_count ?? segs.length;
    const sealed = sh.sealed_segment_count;

    const phys = sh.physical_bytes != null
      ? `<span class="stat-val text-muted" style="margin-left:8px;font-size:11px"
               title="Bytes the shard's segment files occupy on disk${sh.logical_bytes != null ? ` (${fmtBytes(sh.logical_bytes)} of tracked record bytes)` : ''}">${fmtBytes(sh.physical_bytes)} on disk</span>`
      : '';

    const meta = [
      `${n} seg${n === 1 ? '' : 's'}`,
      sealed != null ? `${sealed} sealed` : null,
      sh.active_segment_id != null ? `active #${sh.active_segment_id}` : null,
      sh.next_segment_id != null ? `next #${sh.next_segment_id}` : null,
    ].filter(Boolean).join(' · ');

    return `
      <div class="vlog-shard">
        <div class="vlog-shard-head" onclick="toggleVlogShard('${panelId}', this)"
             title="Click to list this shard's segment files.${sh.next_segment_id != null
               ? ` Segment ids are never reused, so next #${sh.next_segment_id} also counts every segment this shard has ever created.` : ''}">
          <span class="vlog-caret">▸</span>
          <span class="stat-key">Shard ${sh.bucket}</span>
          <span class="stat-val">${fmtBytes(sh.live_bytes)} live</span>
          <span class="stat-val ${sc}" style="margin-left:8px">${sh.waste_ratio_pct.toFixed(1)}% waste</span>
          ${phys}
        </div>
        <div class="vlog-shard-meta">${esc(meta)}</div>
        <div class="vlog-seg-list" id="${panelId}" style="display:none">
          ${renderVlogSegmentRows(segs)}
        </div>
      </div>`;
  }).join('');

  return `
    <div class="admin-card-title" style="margin-top:10px;margin-bottom:4px">SHARDS (${shards.length})</div>
    ${rows}`;
}

function renderVlogSegmentRows(segs) {
  if (!segs.length) {
    return '<div class="text-muted" style="font-size:11px;padding:4px 0">No segment files yet</div>';
  }
  return segs.map(s => {
    const gc = s.garbage_ratio_pct > 40 ? 'bad' : s.garbage_ratio_pct > 20 ? 'warn' : 'good';
    // The active tail is still being appended to and is never a GC target, so it is
    // called out even when its garbage ratio looks alarming.
    const tag = s.sealed
      ? '<span class="badge badge-attr" title="Immutable — GC selects from these">sealed</span>'
      : '<span class="badge badge-indexed" title="The active tail: still being appended to, never collected">active</span>';
    return `
      <div class="vlog-seg" title="File ${fmtBytes(s.file_bytes)} (16-byte header + records) · ${fmtBytes(s.total_bytes)} of records, ${fmtBytes(s.live_bytes)} live / ${fmtBytes(s.garbage_bytes)} garbage">
        <span class="vlog-seg-id">seg ${s.segment_id}</span>
        <span class="vlog-seg-file">${fmtBytes(s.file_bytes)}</span>
        <span class="stat-val">${fmtBytes(s.live_bytes)} live</span>
        <span class="stat-val ${gc}">${s.garbage_ratio_pct.toFixed(0)}% garbage</span>
        <span class="vlog-seg-bar">
          <span class="progress-wrap" style="height:4px">
            <span class="progress-bar" style="display:block;height:100%;width:${Math.min(s.garbage_ratio_pct, 100)}%;
                  background:${s.garbage_ratio_pct > 40 ? 'var(--error)' : s.garbage_ratio_pct > 20 ? 'var(--warning)' : 'var(--success)'}"></span>
          </span>
        </span>
        ${tag}
      </div>`;
  }).join('');
}

function toggleVlogShard(panelId, head) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'block';
  const caret = head?.querySelector('.vlog-caret');
  if (caret) caret.textContent = open ? '▸' : '▾';
}

function renderTtlCard(m) {
  return `
    <div class="admin-card" style="flex:1">
      <div class="admin-card-title">TTL CONFIGURATION</div>
      <div class="stat-row"><span class="stat-key">TTL Period</span>
        <span class="stat-val">${fmtDuration(m.ttl_secs)}</span></div>
      ${m.ttl_max_deletes_per_run != null
        ? `<div class="stat-row"><span class="stat-key">Max Deletes / Run</span>
           <span class="stat-val">${fmt(m.ttl_max_deletes_per_run)}</span></div>`
        : ''}
    </div>`;
}

function renderSystemStoreMeta(m) {
  return `
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:10px;padding-top:10px;
                border-top:1px solid var(--border)">
      ${m.ttl_enabled ? renderTtlCard(m) : ''}
      ${renderLsmCard(m.lsm)}
      ${renderVlogCard(m.value_log)}
    </div>`;
}

function renderDocStoreKvMeta(m) {
  const companionHtml = (m.associated_stores ?? []).length === 0 ? '' : `
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
      <div class="admin-card-title" style="margin-bottom:10px">
        COMPANION STORES (${m.associated_stores.length})
      </div>
      ${m.associated_stores.map(s => `
        <div style="margin-bottom:14px">
          <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px">
            <span class="sys-store-name">${esc(s.name)}</span>
            <span class="text-muted" style="font-size:11px">${esc(s.purpose)}</span>
          </div>
          <div style="display:flex;gap:12px;flex-wrap:wrap">
            ${renderLsmCard(s.lsm)}
            ${renderVlogCard(s.value_log)}
          </div>
        </div>
      `).join('')}
    </div>`;

  return `
    <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        ${renderLsmCard(m.lsm)}
        ${renderVlogCard(m.value_log)}
      </div>
      ${companionHtml}
    </div>`;
}

function fmtDuration(secs) {
  if (!secs) return '';
  if (secs < 3600) return `${secs}s`;
  if (secs < 86400) return `${(secs / 3600).toFixed(0)}h`;
  return `${(secs / 86400).toFixed(0)}d`;
}

async function adminRefresh() {
  await loadStorageStats();
  toast('Stats refreshed');
}

async function adminTriggerGc() {
  const el = document.getElementById('admin-action-result');
  if (!el) return;
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const r = await Api.triggerGc();
    el.innerHTML = `<div class="alert alert-success">
      GC complete — ${r.namespaces_collected} namespace(s) collected.
      ${r.results.map(x => `<br>${esc(x.namespace)}: ${fmtBytes(x.bytes_reclaimed)} reclaimed`
        + `${x.gc_duration_ms != null ? ` in ${fmtMillis(x.gc_duration_ms)}` : ''}`
        + `${x.bytes_live != null ? ` · ${fmtBytes(x.bytes_live)} live` : ''}`).join('')}
    </div>`;
    toast('GC complete');
    loadStorageStats();
  } catch (e) {
    el.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
  }
}

async function adminTriggerWalGc() {
  const el = document.getElementById('admin-action-result');
  if (!el) return;
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const r = await Api.triggerWalGc();
    // Servers before minnal#28 sent these two values under the wrong names
    // (total_entries = bytes reclaimed, persisted_entries = entries still unpersisted).
    const reclaimed = r.bytes_reclaimed ?? r.total_entries;
    const unpersisted = r.unpersisted_entries ?? r.persisted_entries;
    el.innerHTML = `<div class="alert alert-success">
      WAL GC complete — reclaimed ${fmtBytes(reclaimed)};
      ${fmt(unpersisted)} entries still waiting to be persisted
    </div>`;
    toast('WAL GC complete');
    loadStorageStats();
  } catch (e) {
    el.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
  }
}

async function adminCompact() {
  const el = document.getElementById('admin-action-result');
  if (!el) return;
  el.innerHTML = '<div class="spinner"></div>';
  try {
    await Api.compact();
    el.innerHTML = '<div class="alert alert-success">LSM compaction complete</div>';
    toast('Compaction complete');
  } catch (e) {
    el.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
  }
}

async function adminIndexCheckpoint(btn) {
  const el = document.getElementById('admin-action-result');
  if (!el) return;
  if (btn) btn.disabled = true;
  el.innerHTML = '<div class="spinner"></div>';
  try {
    await Api.indexCheckpoint();
    const msg = 'Index checkpoint started — the flush and compaction run in the background. '
      + 'Check the server log file for progress and the checkpointed field count.';
    el.innerHTML = `<div class="alert alert-success">${msg}</div>`;
    toast('Index checkpoint started — see log for progress');
    loadStorageStats();
  } catch (e) {
    el.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
    toast(`Index checkpoint failed: ${e.message}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function adminClearQueryCache() {
  const el = document.getElementById('admin-action-result');
  if (!el) return;
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const result = await Api.clearQueryEmbeddingCache();
    const cleared = result?.cleared ?? 0;
    el.innerHTML = `<div class="alert alert-success">Query embedding cache cleared — ${fmt(cleared)} entr${cleared === 1 ? 'y' : 'ies'} removed</div>`;
    toast(`Query cache cleared (${fmt(cleared)} entries)`);
  } catch (e) {
    el.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
    toast(`Clear cache failed: ${e.message}`, 'error');
  }
}

async function adminExportSchema(ns) {
  try {
    const blob = await Api.exportSchema(ns);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${ns}-schema.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    toast(`Schema for '${ns}' downloaded`);
  } catch (e) {
    toast(`Export failed: ${e.message}`, 'error');
  }
}

function adminImportSchema() {
  const input = document.getElementById('admin-import-file');
  if (input) { input.value = ''; input.click(); }
}

async function adminImportSchemaFile(input) {
  const file = input.files[0];
  if (!file) return;
  const el = document.getElementById('admin-action-result');
  if (el) el.innerHTML = '<div class="spinner"></div>';
  try {
    const text = await file.text();
    let schema;
    try { schema = JSON.parse(text); } catch { throw new Error('Invalid JSON file'); }
    // The unified import endpoint dispatches on the schema's `store_type`.
    const isKv = schema.store_type === 'kv' || (schema.store_type == null && schema.value_type != null);
    await Api.importStoreSchema(schema);
    const storeKind = isKv ? 'KV store' : 'store';
    if (el) el.innerHTML = `<div class="alert alert-success">Schema imported — ${storeKind} '${esc(schema.namespace ?? file.name)}' created</div>`;
    toast(`Schema imported from ${file.name}`);
    await loadStores();
  } catch (e) {
    if (el) el.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
    toast(`Import failed: ${e.message}`, 'error');
  }
}

async function adminExportKvSchema(ns) {
  try {
    // Unified export resolves the kind from the stored schema.
    const blob = await Api.exportSchema(ns);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${ns}-kv-schema.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    toast(`KV schema for '${ns}' downloaded`);
  } catch (e) {
    toast(`Export failed: ${e.message}`, 'error');
  }
}

// ── Admin index panel ─────────────────────────────────────────────────────────

const vqState = {
  retriedPage:     1,
  retriedPageSize: 20,
  nsPage:          1,
  nsPageSize:      20,
  selectedNs:      '',
  nsMode:          'all',  // 'all' | 'retried'
  maxRetries:      0,
};

async function loadAdminIndexPanel() {
  const panel = document.getElementById('admin-index-panel');
  if (!panel) return;
  panel.innerHTML = `
    <div class="admin-actions">
      <button class="btn btn-secondary" onclick="adminIndexRefresh()">↻ Refresh</button>
      <button class="btn btn-ghost" onclick="adminVectorReconcile(this)"
              title="Scan all vector-indexed namespaces and re-enqueue any documents missing a vector entry">⚡ Reconcile Vector Index</button>
    </div>
    <div id="admin-index-action-result"></div>
    <div id="admin-index-builds"></div>
    <div id="admin-index-health"></div>
    <div class="index-frame">
      <div class="index-frame-title">VECTOR INDEX</div>
      <div id="admin-index-vector-stats"><div class="spinner"></div></div>
      <div id="admin-index-queue-browser">
        ${renderVqBrowserHtml()}
      </div>
    </div>
    <div id="admin-index-waste"></div>
    <div id="admin-index-operations"></div>
  `;
  await adminIndexRefresh();
}

async function adminIndexRefresh() {
  const builds  = document.getElementById('admin-index-builds');
  const vstats  = document.getElementById('admin-index-vector-stats');
  const waste   = document.getElementById('admin-index-waste');
  const ops     = document.getElementById('admin-index-operations');
  if (!vstats) return;
  vstats.innerHTML = '<div class="spinner"></div>';
  try {
    const [progress, summary, corruption, wasteRes] = await Promise.all([
      Api.indicesProgress(),
      Api.vectorQueueSummary(),
      Api.vectorCorruptionMetrics().catch(() => null),
      Api.indexWaste().catch(() => null),
    ]);
    vqState.maxRetries = summary?.max_retries_configured ?? 0;
    // Attribute (field) builds sit above the frame; vector stats fill the
    // frame; field-index waste and index operations go below. The queue
    // browser is a persistent child of the frame and is not re-rendered
    // here so its results survive.
    if (builds) builds.innerHTML = renderAttributeBuildsSection(progress?.attribute_builds ?? []);
    vstats.innerHTML = `
      ${renderVectorProgressSection(progress?.vector_progress ?? [])}
      ${renderVectorQueueSummarySection(summary)}
      ${renderVectorCorruptionSection(corruption)}
    `;
    if (waste) waste.innerHTML = renderIndexWasteSection(wasteRes);
    if (ops) ops.innerHTML = renderNamespaceControlsSection(summary?.by_namespace ?? []);
    refreshVqNsSelect(summary?.by_namespace ?? []);
  } catch (e) {
    vstats.innerHTML = `<div class="alert alert-error">Failed to load index data: ${esc(e.message)}</div>`;
  }
  // Health fans out one request per indexed namespace, so it loads on its own
  // and a failure there never blanks the rest of the panel.
  loadFieldIndexHealth();
}

// ── Field index health / repair ───────────────────────────────────────────────
//
// The per-query `degraded_fields` warning tells a *caller* their answer may be
// short; this tells an operator which indices to repair. Loaded on every panel
// refresh so a degraded index is visible without anyone having to click.

async function loadFieldIndexHealth() {
  const el = document.getElementById('admin-index-health');
  if (!el) return;

  const namespaces = state.stores
    .filter(s => (s.indices?.length ?? 0) > 0)
    .map(s => s.namespace);

  if (!namespaces.length) { el.innerHTML = ''; return; }

  el.innerHTML = '<div class="spinner"></div>';
  const results = await Promise.all(namespaces.map(ns =>
    Api.indexHealth(ns)
      .then(data => ({ ns, data }))
      .catch(e => ({ ns, error: e.message }))
  ));
  el.innerHTML = renderFieldIndexHealthSection(results);
}

// Cause and repair mode both matter: a wedged checkpoint worker, a crash after
// bulk loading, and a genuine index fault produce the same symptom but have
// completely different fixes.
const GAP_CAUSES = {
  backstop_reclaim: {
    label: 'backstop reclaim',
    hint:  'WAL GC reclaimed a segment this field still needed — the index-replay watermark had fallen too far behind. Check whether the index checkpoint worker is wedged.',
  },
  no_wal_writes: {
    label: 'no-WAL writes',
    hint:  'The database came up after an unclean shutdown with no-WAL writes outstanding. Those writes have no WAL entries, so repair is necessarily a full rebuild.',
  },
  rejected_update: {
    label: 'rejected update',
    hint:  'A field index refused an update on the write path. The affected keys were captured exactly, so repair is row-scoped.',
  },
};

function renderFieldIndexHealthSection(results) {
  state._healthGaps = [];

  const rows = [];
  let degradedCount = 0;
  let fieldCount    = 0;

  results.forEach(r => {
    if (r.error) {
      rows.push({ degraded: false, html: `
        <tr>
          <td class="text-mono">${esc(r.ns)}</td>
          <td colspan="5" class="text-muted" style="font-size:11px">${esc(r.error)}</td>
        </tr>` });
      return;
    }

    (r.data?.fields ?? []).forEach(f => {
      fieldCount++;
      const gap = f.gap ?? null;
      if (gap) degradedCount++;

      const badges = [
        gap    ? '<span class="badge badge-error">⚠ Degraded</span>'
               : '<span class="badge badge-indexed">✓ Healthy</span>',
        f.active ? '' : '<span class="badge badge-attr" title="Not activated in memory, so not queryable — a different condition from a degraded index.">inactive</span>',
      ].filter(Boolean).join(' ');

      // "never" is not a fault on its own: a field that has taken no writes has
      // nothing to checkpoint.
      const checkpoint = f.checkpoint_offset != null
        ? `<span class="text-mono">${fmt(f.checkpoint_offset)}</span>`
        : '<span class="text-muted" title="Never checkpointed — nothing has been persisted for this field yet.">never</span>';

      let gapCell = '<span class="text-muted">—</span>';
      let gapBtn  = '';
      if (gap) {
        const cause = GAP_CAUSES[gap.cause] ?? { label: gap.cause, hint: '' };
        const mode  = gap.repair?.mode === 'row_scoped'
          ? `row-scoped · ${fmt(gap.repair.keys?.length ?? 0)} key${(gap.repair.keys?.length ?? 0) === 1 ? '' : 's'}`
          : 'full rebuild';
        // Detection time answers the first question an operator asks: how long
        // have queries on this field been returning short answers?
        const since = gap.detected_at_ms
          ? `<div class="text-muted" style="font-size:11px">since ${esc(new Date(gap.detected_at_ms).toLocaleString())}</div>`
          : '';
        gapCell = `
          <span class="stat-val bad" title="${esc(cause.hint)}">${esc(cause.label)}</span>
          <span class="text-muted" style="font-size:11px"> · ${esc(mode)}</span>
          ${since}`;
        const idx = state._healthGaps.push({ ns: r.ns, field: f.field_name, gap }) - 1;
        gapBtn = `<button class="btn btn-xs btn-ghost" onclick="showIndexGap(${idx})"
                          title="Full gap record: WAL range, missing segments, worklist">Gap…</button>`;
      }

      rows.push({ degraded: !!gap, html: `
        <tr>
          <td class="text-mono">${esc(r.ns)}</td>
          <td class="text-mono">${esc(f.field_name)}</td>
          <td>${badges}</td>
          <td style="text-align:right">${checkpoint}</td>
          <td>${gapCell}</td>
          <td class="ns-ops-actions gap-8">
            ${gapBtn}
            ${gap ? `<button class="btn btn-xs btn-accent"
                             onclick="adminRepairFieldIndex('${esc(r.ns)}','${esc(f.field_name)}',this)"
                             title="Replay the gap's worklist (or rebuild the field) and clear the gap record">Repair</button>` : ''}
          </td>
        </tr>` });
    });
  });

  if (!rows.length) return '';

  // Degraded first — the whole point of the section is that damage is not
  // something you have to scroll for.
  const ordered = [...rows].sort((a, b) => Number(b.degraded) - Number(a.degraded));

  const banner = degradedCount > 0
    ? `<div class="alert alert-warning">
         ⚠ <strong>${fmt(degradedCount)} field ${degradedCount === 1 ? 'index is' : 'indices are'} incomplete.</strong>
         Queries touching ${degradedCount === 1 ? 'it' : 'them'} return <em>degraded_fields</em> and may be
         missing rows until repaired.
       </div>`
    : '';

  return `
    <div class="section">
      <div class="section-header">
        <span class="section-title">FIELD INDEX HEALTH (${fmt(fieldCount)}${degradedCount > 0 ? ` · ${fmt(degradedCount)} degraded` : ''})</span>
      </div>
      ${banner}
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr>
          <th>Namespace</th><th>Field</th><th>Status</th>
          <th style="text-align:right" title="WAL offset the field's persisted index reflects.">Checkpoint</th>
          <th title="Why the index is incomplete, and what repair it needs.">Gap</th>
          <th>Operations</th>
        </tr></thead>
        <tbody>${ordered.map(r => r.html).join('')}</tbody>
      </table></div>
    </div>
  `;
}

function showIndexGap(idx) {
  const entry = state._healthGaps?.[idx];
  if (!entry) return;
  openModal(`
    <div class="modal-title">Gap Record — ${esc(entry.ns)} / ${esc(entry.field)}</div>
    <div class="json-view" style="max-height:60vh;overflow:auto;padding:12px">${prettyJson(entry.gap)}</div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Close</button>
    </div>
  `);
}

async function adminRepairFieldIndex(ns, field, btn) {
  if (!confirm(`Repair the "${field}" index of "${ns}"?\n\nThis re-reads each affected key's current value — it is safe to run more than once. A full rebuild scans the namespace and can take a while on a large store.`)) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Repairing…';
  try {
    const res = await Api.attributeRepair(ns, field);
    if (res?.status === 'not_degraded') {
      toast(`"${field}" had no outstanding gap — nothing to repair`);
    } else {
      const o = res?.result ?? {};
      const detail = o.outcome === 'row_scoped'
        ? `${fmt(o.reindexed)} reindexed, ${fmt(o.absent)} absent of ${fmt(o.keys_total)} keys`
        : o.outcome === 'full_rebuild'
          ? `full rebuild — ${fmt(o.scanned)} keys scanned`
          : 'done';
      toast(`Repaired "${ns}" / "${field}": ${detail}`);
    }
    loadFieldIndexHealth();
  } catch (e) {
    toast('Repair failed: ' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = original;
  }
}

function renderAttributeBuildsSection(builds) {
  const rows = builds.map(b => {
    const field  = b.id?.field ?? '?';
    const ns     = b.id?.namespace ?? '?';
    const status = (b.status ?? 'Unknown').toLowerCase();
    const pct    = b.total > 0 ? (b.indexed / b.total * 100) : 0;
    const statusHtml = status === 'running'
      ? `<div style="display:flex;align-items:center;gap:8px">
           <div class="progress-wrap" style="width:100px;display:inline-block">
             <div class="progress-bar" style="width:${pct.toFixed(1)}%"></div>
           </div>
           <span style="font-size:11px;color:var(--text-2)">${pct.toFixed(1)}%</span>
         </div>`
      : status === 'complete'
        ? '<span class="badge badge-indexed">✓ Complete</span>'
        : `<span class="badge badge-error">${esc(b.status ?? 'Unknown')}</span>`;

    return `
      <tr>
        <td class="text-mono">${esc(ns)}</td>
        <td class="text-mono">${esc(field)}</td>
        <td>${statusHtml}</td>
        <td style="text-align:right">${fmt(b.indexed)} / ${fmt(b.total)}</td>
        <td style="text-align:right">${b.failed > 0 ? `<span class="stat-val bad">${fmt(b.failed)}</span>` : '<span class="text-muted">0</span>'}</td>
        <td class="text-muted" style="font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis">${b.last_error ? esc(b.last_error) : '—'}</td>
      </tr>`;
  }).join('');

  return `
    <div class="section">
      <div class="section-header">
        <span class="section-title">ACTIVE INDEX BUILDS (${builds.length})</span>
      </div>
      ${builds.length === 0
        ? '<div class="text-muted" style="padding:8px 0">No active index builds</div>'
        : `<div class="tbl-wrap"><table class="tbl">
            <thead><tr>
              <th>Namespace</th><th>Field</th><th>Progress</th>
              <th style="text-align:right">Indexed / Total</th>
              <th style="text-align:right">Failed</th><th>Last Error</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table></div>`}
    </div>
  `;
}

function renderVectorProgressSection(vectorProgress) {
  if (vectorProgress.length === 0) return '';

  const rows = vectorProgress.map(p => {
    const pct   = Math.min(p.progress_pct ?? 0, 100);
    const color = pct >= 90 ? 'var(--success)' : pct >= 50 ? 'var(--warning)' : 'var(--error)';
    const exhaustedNote = p.exhausted > 0
      ? ` / <span style="color:var(--error)">${fmt(p.exhausted)} exhausted</span>`
      : '';
    return `
      <div class="vq-progress-row">
        <div class="vq-progress-ns">
          <span>${esc(p.namespace)}</span>
          <span style="color:var(--text-2)">
            ${pct.toFixed(1)}% &mdash; ${fmt(p.indexed_approx)} indexed / ${fmt(p.pending)} pending${exhaustedNote}
          </span>
        </div>
        <div class="progress-wrap">
          <div class="progress-bar" style="width:${pct}%;background:${color}"></div>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="section">
      <div class="section-header">
        <span class="section-title">VECTOR INDEXING PROGRESS</span>
      </div>
      <div style="padding:4px 0">${rows}</div>
    </div>
  `;
}

function renderVectorQueueSummarySection(summary) {
  const totalPending    = summary?.total_pending    ?? 0;
  const totalActionable = summary?.total_actionable ?? 0;
  const totalRetrying   = summary?.total_retrying   ?? 0;
  const totalExhausted  = summary?.total_exhausted  ?? 0;
  const maxRetries      = summary?.max_retries_configured ?? '—';

  const exhaustedClass = totalExhausted > 0 ? 'bad'  : 'good';
  const pendingClass   = totalPending   > 0 ? 'warn' : 'good';
  const retryingClass  = totalRetrying  > 0 ? 'warn' : '';

  return `
    <div class="section">
      <div class="section-header">
        <span class="section-title">VECTOR QUEUE TOTALS</span>
      </div>
      <div class="admin-grid" style="max-width:480px">
        <div class="admin-card">
          <div class="stat-row"><span class="stat-key" title="Max embedding attempts per queue entry before it becomes exhausted (vector_index.max_retries config).">Max Retries</span>
            <span class="stat-val">${maxRetries}</span></div>
          <div class="stat-row"><span class="stat-key" title="Documents enqueued and awaiting embedding across all namespaces (actionable + retrying + exhausted).">Total Pending</span>
            <span class="stat-val ${pendingClass}">${fmt(totalPending)}</span></div>
          <div class="stat-row"><span class="stat-key" title="Entries the worker will process now — not yet failed, or past their retry back-off.">Actionable</span>
            <span class="stat-val">${fmt(totalActionable)}</span></div>
          <div class="stat-row"><span class="stat-key" title="Entries that failed at least once but are still within the retry budget (waiting out back-off).">Retrying</span>
            <span class="stat-val ${retryingClass}">${fmt(totalRetrying)}</span></div>
          <div class="stat-row"><span class="stat-key" title="Entries that spent their retry budget — stuck until manually reset (Retry Failed) or removed.">Exhausted</span>
            <span class="stat-val ${exhaustedClass}">${fmt(totalExhausted)}</span></div>
        </div>
      </div>
    </div>
  `;
}

// ── Vector index corruption metrics ──────────────────────────────────────────
// Process-wide, monotonic since startup. A non-zero/rising value means stored
// vectors are corrupt and are being skipped at query time — reindex to repair.
// Shape: { "<namespace>": { sparse, dense, total }, ... } (per-namespace snapshot).
function renderVectorCorruptionSection(metrics) {
  if (!metrics) return '';

  // Sort by total skipped (worst first), then namespace name.
  const entries = Object.entries(metrics)
    .map(([ns, m]) => ({
      ns,
      sparse: m?.sparse ?? 0,
      dense:  m?.dense  ?? 0,
      total:  m?.total  ?? 0,
    }))
    .sort((a, b) => b.total - a.total || a.ns.localeCompare(b.ns));

  const grandTotal  = entries.reduce((n, e) => n + e.total,  0);
  const grandSparse = entries.reduce((n, e) => n + e.sparse, 0);
  const grandDense  = entries.reduce((n, e) => n + e.dense,  0);

  const rows = entries.length
    ? entries.map(e => `
        <tr>
          <td class="text-mono">${esc(e.ns)}</td>
          <td><span class="stat-val ${e.sparse > 0 ? 'warn' : ''}">${fmt(e.sparse)}</span></td>
          <td><span class="stat-val ${e.dense  > 0 ? 'warn' : ''}">${fmt(e.dense)}</span></td>
          <td><span class="stat-val ${e.total  > 0 ? 'bad'  : 'good'}">${fmt(e.total)}</span></td>
        </tr>`).join('')
    : `<tr><td colspan="4" class="text-muted" style="padding:14px 12px">No namespaces with vector indices</td></tr>`;

  return `
    <div class="section">
      <div class="section-header">
        <span class="section-title">VECTOR INDEX CORRUPTION METRICS</span>
        <span class="text-muted" style="font-size:12px">
          entries skipped on read since startup${grandTotal > 0
            ? ' · <span class="stat-val bad">corrupt vectors present</span> — reindex affected namespaces'
            : ' · no corruption detected'}
        </span>
      </div>
      <div class="tbl-wrap">
        <table class="tbl ns-ops-tbl">
          <colgroup><col class="ns-ops-col-ns"><col><col><col></colgroup>
          <thead><tr>
            <th>Namespace</th>
            <th title="Sparse-vector entries (search Pass 1) skipped because their stored bytes failed to deserialize.">Sparse (Pass-1)</th>
            <th title="Dense-vector entries (search Pass 2) skipped because their stored bytes failed to deserialize.">Dense (Pass-2)</th>
            <th title="Total entries skipped on read since startup (in-memory, resets on restart). Rising = stored vectors are corrupt and queries are silently degraded — run a validating Reconcile.">Total Skipped</th>
          </tr></thead>
          <tbody>${rows}</tbody>
          ${entries.length > 1 ? `
          <tfoot><tr>
            <td class="text-mono"><strong>All namespaces</strong></td>
            <td><span class="stat-val ${grandSparse > 0 ? 'warn' : ''}">${fmt(grandSparse)}</span></td>
            <td><span class="stat-val ${grandDense  > 0 ? 'warn' : ''}">${fmt(grandDense)}</span></td>
            <td><span class="stat-val ${grandTotal  > 0 ? 'bad'  : 'good'}">${fmt(grandTotal)}</span></td>
          </tr></tfoot>` : ''}
        </table>
      </div>
    </div>
  `;
}

function renderNamespaceControlsSection(byNs) {
  const byNsMap = Object.fromEntries(byNs.map(x => [x.namespace, x]));

  const relevantStores = [
    ...state.stores.map(s => ({ ...s, storeType: 'doc' })),
    ...state.kvStores.map(s => ({ ...s, storeType: 'kv' })),
  ].filter(s => {
    const hasIndices = s.storeType === 'doc' && (s.indices?.length ?? 0) > 0;
    return hasIndices || s.semantic_search_enabled;
  });

  if (relevantStores.length === 0) return `
    <div class="section">
      <div class="section-header"><span class="section-title">INDEX OPERATIONS</span></div>
      <div class="text-muted" style="padding:8px 0">No stores with field indices or semantic search</div>
    </div>
  `;

  // Split by index type so each sub-tab holds a homogeneous, well-aligned table.
  const fieldRows = [];
  const vectorRows = [];

  relevantStores.forEach(s => {
    const ns         = s.namespace;
    const qStats     = byNsMap[ns];
    const hasIndices = s.storeType === 'doc' && (s.indices?.length ?? 0) > 0;
    const hasVector  = !!s.semantic_search_enabled;
    const pending    = qStats?.pending   ?? 0;
    const exhausted  = qStats?.exhausted ?? 0;

    if (hasIndices) {
      const indicesHtml = s.indices.map(ix =>
        `<span class="badge badge-attr" style="margin-right:2px">${esc(ix.field)} <span style="opacity:.6">${esc(ix.index_type)}</span></span>`
      ).join('');
      fieldRows.push(`
        <tr>
          <td class="text-mono">${esc(ns)}</td>
          <td>${indicesHtml}</td>
          <td class="ns-ops-actions gap-8">
            <button class="btn btn-xs btn-ghost" onclick="toggleFieldBlobStats('${esc(ns)}',this)"
                    title="On-disk blob growth/waste per field (complements fleet-wide Field Index Waste)">Blob Stats ▾</button>
            <button class="btn btn-xs btn-ghost" onclick="showReindexDocFieldModal('${esc(ns)}')"
                    title="Reindex one field of a single document (synchronous)">Reindex Doc…</button>
            <button class="btn btn-xs btn-ghost" onclick="adminAttrReindexAll('${esc(ns)}',this)"
                    title="Drop and rebuild all field indices (async 202)">Reindex All</button>
            <button class="btn btn-xs btn-danger" onclick="adminAttrDropAll('${esc(ns)}',this)"
                    title="Drop all field indices without rebuilding (async 202)">Drop All</button>
          </td>
        </tr>
        <tr id="blob-row-${esc(ns)}" style="display:none">
          <td colspan="3" id="blob-cell-${esc(ns)}" style="padding:0"></td>
        </tr>`);
    }

    if (hasVector) {
      const queueDepthHtml = pending === 0 && exhausted === 0
        ? '<span class="text-muted">idle</span>'
        : [
            pending   > 0 ? `<span class="stat-val warn" style="font-size:11px">${fmt(pending)} pending</span>`     : '',
            exhausted > 0 ? `<span class="stat-val bad"  style="font-size:11px">${fmt(exhausted)} exhausted</span>` : '',
          ].filter(Boolean).join(' ');
      vectorRows.push(`
        <tr>
          <td class="text-mono">${esc(ns)}</td>
          <td>${queueDepthHtml}</td>
          <td class="ns-ops-actions gap-8">
            <button class="btn btn-xs btn-ghost" onclick="showReindexDocVectorModal('${esc(ns)}')"
                    title="Re-enqueue a single document for embedding">Reindex Doc…</button>
            <button class="btn btn-xs btn-ghost" onclick="adminVectorReindexAll('${esc(ns)}',this)"
                    title="Re-enqueue all documents for embedding (async 202)">Reindex All</button>
            ${exhausted > 0 ? `
              <button class="btn btn-xs btn-accent" onclick="adminVectorReindexFailed('${esc(ns)}',this)"
                      title="Reset exhausted entries so they can be retried">Retry Failed (${exhausted})</button>
            ` : ''}
            <button class="btn btn-xs btn-danger" onclick="adminVectorDropAll('${esc(ns)}',this)"
                    title="Disable semantic search and clear all vector data (async 202)">Drop All</button>
          </td>
        </tr>`);
    }
  });

  const activeTab = state.nsOpsTab === 'vector' && vectorRows.length ? 'vector'
                  : state.nsOpsTab === 'field'  && fieldRows.length  ? 'field'
                  : fieldRows.length ? 'field' : 'vector';

  const emptyRow = (cols, msg) =>
    `<tr><td colspan="${cols}" class="text-muted" style="padding:14px 12px">${msg}</td></tr>`;

  const fieldTable = `
    <div class="tbl-wrap">
      <table class="tbl ns-ops-tbl">
        <colgroup>
          <col class="ns-ops-col-ns"><col><col class="ns-ops-col-actions">
        </colgroup>
        <thead><tr>
          <th>Namespace</th><th>Indexed Fields</th><th>Operations</th>
        </tr></thead>
        <tbody>${fieldRows.join('') || emptyRow(3, 'No stores with field indices')}</tbody>
      </table>
    </div>`;

  const vectorTable = `
    <div class="tbl-wrap">
      <table class="tbl ns-ops-tbl">
        <colgroup>
          <col class="ns-ops-col-ns"><col><col class="ns-ops-col-actions">
        </colgroup>
        <thead><tr>
          <th>Namespace</th>
          <th title="Embedding queue backlog for this namespace — pending (awaiting embedding) and exhausted (gave up after max retries) counts. 'idle' means the queue is empty.">Queue Depth</th>
          <th>Operations</th>
        </tr></thead>
        <tbody>${vectorRows.join('') || emptyRow(3, 'No stores with semantic search enabled')}</tbody>
      </table>
    </div>`;

  return `
    <div class="section">
      <div class="section-header">
        <span class="section-title">INDEX OPERATIONS (${relevantStores.length})</span>
      </div>
      <div class="sub-tab-nav">
        <button class="sub-tab-btn ${activeTab === 'field' ? 'active' : ''}"
                data-nsops-tab="field" onclick="switchNsOpsTab('field')">Field Indices (${fieldRows.length})</button>
        <button class="sub-tab-btn ${activeTab === 'vector' ? 'active' : ''}"
                data-nsops-tab="vector" onclick="switchNsOpsTab('vector')">Vector Semantic (${vectorRows.length})</button>
      </div>
      <div id="nsops-field-panel" class="sub-panel ${activeTab === 'field' ? 'active' : ''}">${fieldTable}</div>
      <div id="nsops-vector-panel" class="sub-panel ${activeTab === 'vector' ? 'active' : ''}">${vectorTable}</div>
    </div>
  `;
}

function switchNsOpsTab(tab) {
  state.nsOpsTab = tab;
  document.querySelectorAll('[data-nsops-tab]').forEach(b =>
    b.classList.toggle('active', b.dataset.nsopsTab === tab));
  ['field', 'vector'].forEach(t => {
    const p = document.getElementById(`nsops-${t}-panel`);
    if (p) p.classList.toggle('active', t === tab);
  });
}

function renderVqBrowserHtml() {
  const allNs = [...new Set([
    ...state.stores.map(s => s.namespace),
    ...state.kvStores.filter(s => s.semantic_search_enabled).map(s => s.namespace),
  ])].sort();

  const nsOptions = allNs.map(ns =>
    `<option value="${esc(ns)}">${esc(ns)}</option>`
  ).join('');

  return `
    <div class="section">
      <div class="section-header">
        <span class="section-title">QUEUE BROWSER</span>
      </div>
      <div class="vq-browser-bar">
        <button class="btn btn-ghost" onclick="vqLoadRetried(1)">All Retried Entries</button>
        <span style="color:var(--text-3);font-size:12px">or browse by namespace:</span>
        <select id="vq-ns-select">
          <option value="">— select namespace —</option>
          ${nsOptions}
        </select>
        <select id="vq-ns-mode">
          <option value="all">All entries</option>
          <option value="retried">Retried only</option>
        </select>
        <button class="btn btn-ghost" onclick="vqBrowseNs(1)">Browse</button>
      </div>
      <div id="vq-browser-result"></div>
    </div>
  `;
}

function refreshVqNsSelect(byNs = []) {
  const sel = document.getElementById('vq-ns-select');
  if (!sel) return;
  const queueNsSet = new Set(byNs.map(n => n.namespace));
  const allNs = [...new Set([
    ...byNs.map(n => n.namespace),
    ...state.stores.map(s => s.namespace),
    ...state.kvStores.filter(s => s.semantic_search_enabled).map(s => s.namespace),
  ])].sort();
  const prevVal = sel.value;
  sel.innerHTML = `<option value="">— select namespace —</option>` +
    allNs.map(ns =>
      `<option value="${esc(ns)}" ${ns === prevVal ? 'selected' : ''}>
        ${esc(ns)}${queueNsSet.has(ns) ? '' : ' (no pending)'}
      </option>`
    ).join('');
}

// ── Global vector reconcile ───────────────────────────────────────────────────

async function adminVectorReconcile(btn) {
  const el = document.getElementById('admin-index-action-result');
  btn.disabled = true;
  if (el) el.innerHTML = '<div class="spinner"></div>';
  try {
    await Api.vectorReconcile();
    const msg = 'Vector index reconcile started — it runs in the background. '
      + 'Check the server log file for progress, the re-enqueued count, and any errors.';
    if (el) el.innerHTML = `<div class="alert alert-success">${msg}</div>`;
    toast('Reconcile started — see log for progress');
    await adminIndexRefresh();
  } catch (e) {
    if (el) el.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
    toast(`Reconcile failed: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ── Namespace index operations (async 202) ────────────────────────────────────

async function adminAttrReindexAll(ns, btn) {
  if (!confirm(`Drop and rebuild all field indices for "${ns}"?\n\nThis runs in the background — monitor progress in Active Index Builds.`)) return;
  btn.disabled = true;
  try {
    await Api.attributeReindexAll(ns);
    toast(`Attribute reindex started for "${ns}"`);
    adminIndexRefresh();
  } catch (e) {
    toast('Failed: ' + e.message, 'error');
    btn.disabled = false;
  }
}

async function adminAttrDropAll(ns, btn) {
  if (!confirm(`Drop all field indices for "${ns}"?\n\nThis cannot be undone.`)) return;
  btn.disabled = true;
  try {
    await Api.attributeDropAll(ns);
    toast(`All field indices dropped for "${ns}"`);
    await loadStores();
    adminIndexRefresh();
  } catch (e) {
    toast('Failed: ' + e.message, 'error');
    btn.disabled = false;
  }
}

async function adminVectorReindexAll(ns, btn) {
  if (!confirm(`Re-enqueue all documents in "${ns}" for embedding?\n\nThis runs in the background.`)) return;
  btn.disabled = true;
  try {
    await Api.vectorReindexAll(ns);
    toast(`Vector reindex started for "${ns}"`);
    adminIndexRefresh();
  } catch (e) {
    toast('Failed: ' + e.message, 'error');
    btn.disabled = false;
  }
}

async function adminVectorReindexFailed(ns, btn) {
  if (!confirm(`Reset retry counter for exhausted queue entries in "${ns}"?`)) return;
  btn.disabled = true;
  try {
    const r = await Api.vectorReindexFailed(ns);
    toast(`${r?.retried ?? 0} entries reset in "${ns}"`);
    adminIndexRefresh();
  } catch (e) {
    toast('Failed: ' + e.message, 'error');
    btn.disabled = false;
  }
}

async function adminVectorDropAll(ns, btn) {
  if (!confirm(`Disable semantic search and drop all vector index data for "${ns}"?\n\nThis cannot be undone.`)) return;
  btn.disabled = true;
  try {
    await Api.vectorDropAll(ns);
    toast(`Vector index dropped for "${ns}"`);
    await loadStores();
    adminIndexRefresh();
  } catch (e) {
    toast('Failed: ' + e.message, 'error');
    btn.disabled = false;
  }
}

// ── Single-document reindex (synchronous) ─────────────────────────────────────

function showReindexDocFieldModal(ns) {
  const store   = state.stores.find(s => s.namespace === ns);
  const indices = store?.indices ?? [];
  if (!indices.length) { toast(`"${ns}" has no indexed fields`, 'error'); return; }
  const fieldOpts = indices.map(ix =>
    `<option value="${esc(ix.field)}">${esc(ix.field)} (${esc(ix.index_type)})</option>`
  ).join('');
  openModal(`
    <div class="modal-title">Reindex Field — ${esc(ns)}</div>
    <div class="modal-section">
      <p class="text-muted" style="margin-bottom:12px">
        Re-derive one field's value for a single document from its current stored
        bytes and rewrite just that index entry. The document is not rewritten and
        no other field or vector index is touched.
      </p>
      <div class="form-group" style="margin-bottom:14px">
        <label>FIELD</label>
        <select id="rd-field" style="max-width:280px">${fieldOpts}</select>
      </div>
      <div class="form-group">
        <label>DOCUMENT ID</label>
        <input type="text" id="rd-doc" placeholder="document id" style="max-width:280px" />
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-accent" onclick="submitReindexDocField('${esc(ns)}')">Reindex Field</button>
    </div>
  `);
  setTimeout(() => document.getElementById('rd-doc')?.focus(), 50);
}

async function submitReindexDocField(ns) {
  const field = document.getElementById('rd-field')?.value;
  const docId = document.getElementById('rd-doc')?.value.trim();
  if (!field) { toast('No indexed field selected', 'error'); return; }
  if (!docId) { toast('Document id is required', 'error'); return; }
  try {
    await Api.attributeReindexDoc(ns, field, docId);
    closeModal();
    toast(`Field '${field}' reindexed for doc ${docId}`);
  } catch (e) { toast(e.message, 'error'); }
}

function showReindexDocVectorModal(ns) {
  openModal(`
    <div class="modal-title">Reindex Vector — ${esc(ns)}</div>
    <div class="modal-section">
      <p class="text-muted" style="margin-bottom:12px">
        Re-enqueue a single document for embedding. The worker picks it up on its
        next pass — monitor progress in Vector Queue Totals / Queue Browser.
      </p>
      <div class="form-group">
        <label>DOCUMENT ID</label>
        <input type="text" id="rvd-doc" placeholder="document id" style="max-width:280px" />
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-accent" onclick="submitReindexDocVector('${esc(ns)}')">Re-enqueue</button>
    </div>
  `);
  setTimeout(() => document.getElementById('rvd-doc')?.focus(), 50);
}

async function submitReindexDocVector(ns) {
  const docId = document.getElementById('rvd-doc')?.value.trim();
  if (!docId) { toast('Document id is required', 'error'); return; }
  try {
    const r = await Api.vectorReindexDoc(ns, docId);
    closeModal();
    if (r?.status === 'skipped_empty_text') {
      toast(`Doc ${docId} skipped — no embeddable text`);
    } else {
      toast(`Doc ${docId} re-enqueued for embedding`);
    }
    adminIndexRefresh();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Per-field blob stats (drill-down of fleet-wide Field Index Waste) ─────────

async function toggleFieldBlobStats(ns, btn) {
  const row  = document.getElementById(`blob-row-${ns}`);
  const cell = document.getElementById(`blob-cell-${ns}`);
  if (!row || !cell) return;

  if (row.style.display !== 'none') {
    row.style.display = 'none';
    btn.textContent = 'Blob Stats ▾';
    return;
  }
  row.style.display = '';
  btn.textContent = 'Blob Stats ▴';
  cell.innerHTML = '<div class="spinner" style="margin:12px"></div>';

  const store  = state.stores.find(s => s.namespace === ns);
  const fields = (store?.indices ?? []).map(ix => ix.field);
  if (!fields.length) {
    cell.innerHTML = '<div class="text-muted" style="padding:8px 12px">No indexed fields</div>';
    return;
  }
  try {
    const results = await Promise.all(fields.map(f =>
      Api.fieldBlobStats(ns, f)
        .then(data => ({ field: f, data }))
        .catch(e => ({ field: f, error: e.message }))
    ));
    cell.innerHTML = renderBlobStatsDetail(results);
  } catch (e) {
    cell.innerHTML = `<div class="alert alert-error" style="margin:8px">${esc(e.message)}</div>`;
  }
}

function renderBlobStatsDetail(results) {
  const wasteCell = (ratio, threshold) => {
    if (ratio == null) return '<span class="text-muted">—</span>';
    const pct = ratio * 100;
    const cls = ratio >= threshold ? 'bad' : pct >= threshold * 50 ? 'warn' : 'good';
    return `<span class="stat-val ${cls}">${pct.toFixed(1)}%</span>`;
  };

  const rows = results.map(r => {
    if (r.error) {
      return `<tr>
        <td class="text-mono">${esc(r.field)}</td>
        <td colspan="3" class="text-muted" style="font-size:11px">${esc(r.error)}</td>
      </tr>`;
    }
    const d  = r.data;
    const th = d.waste_threshold ?? 0;
    return `<tr>
      <td class="text-mono">${esc(r.field)}
        ${d.over_threshold ? '<span class="badge badge-error">over threshold</span>' : ''}</td>
      <td style="text-align:right">${fmt(d.distinct_values)}</td>
      <td style="text-align:right">
        ${fmtBytes(d.bitmap_live_bytes)} / ${fmtBytes(d.bitmap_logical_bytes)}
        &nbsp;${wasteCell(d.bitmap_waste_ratio, th)}</td>
      <td style="text-align:right">
        ${fmtBytes(d.keymap_live_bytes)} / ${fmtBytes(d.keymap_logical_bytes)}
        &nbsp;${wasteCell(d.keymap_waste_ratio, th)}</td>
    </tr>`;
  }).join('');

  const threshold = results.find(r => r.data)?.data?.waste_threshold;
  const thPct = threshold != null ? ` · compaction threshold ${(threshold * 100).toFixed(0)}%` : '';

  return `
    <div style="padding:8px 12px;background:var(--bg-2);border-top:1px solid var(--border)">
      <div class="text-muted" style="font-size:11px;margin-bottom:6px">
        On-disk blob growth — <strong>live / logical</strong> bytes and waste ratio per field.
        Complements the fleet-wide <strong>Field Index Waste</strong> overview in the Storage tab;
        a large high-waste bitmap is the signal to run an Index Checkpoint${thPct}.
      </div>
      <table class="tbl" style="width:100%">
        <thead><tr>
          <th>Field</th>
          <th style="text-align:right">Distinct</th>
          <th style="text-align:right">Bitmap live / logical</th>
          <th style="text-align:right">Keymap live / logical</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

async function vqLoadRetried(page) {
  vqState.retriedPage = page;
  const result = document.getElementById('vq-browser-result');
  if (!result) return;
  result.innerHTML = '<div class="spinner" style="margin:12px 0"></div>';
  try {
    const data = await Api.vectorQueueRetried(page, vqState.retriedPageSize);
    result.innerHTML = renderVqTable(data, page, vqState.retriedPageSize, null, null, vqState.maxRetries);
  } catch (e) {
    result.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
  }
}

async function vqBrowseNs(page) {
  const nsSelect   = document.getElementById('vq-ns-select');
  const modeSelect = document.getElementById('vq-ns-mode');
  const ns   = nsSelect?.value;
  const mode = modeSelect?.value ?? 'all';
  if (!ns) { toast('Select a namespace first', 'error'); return; }

  vqState.selectedNs = ns;
  vqState.nsMode     = mode;
  vqState.nsPage     = page;

  const result = document.getElementById('vq-browser-result');
  if (!result) return;
  result.innerHTML = '<div class="spinner" style="margin:12px 0"></div>';

  try {
    const data = mode === 'retried'
      ? await Api.vectorQueueRetriedByNamespace(ns, page, vqState.nsPageSize)
      : await Api.vectorQueueByNamespace(ns, page, vqState.nsPageSize);
    result.innerHTML = renderVqTable(data, page, vqState.nsPageSize, ns, mode, vqState.maxRetries);
  } catch (e) {
    result.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
  }
}

function renderVqTable(data, page, pageSize, ns, mode, maxRetries) {
  const entries    = data?.entries ?? [];
  const total      = data?.total   ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const isNsMode   = !!ns;

  const subtitle = isNsMode
    ? `Namespace <strong style="color:var(--text)">${esc(ns)}</strong> &mdash; ${mode === 'retried' ? 'Retried entries' : 'All entries'} (${fmt(total)} total)`
    : `All retried entries across namespaces (${fmt(total)} total)`;

  const header = `<div style="margin-bottom:8px;font-size:12px;color:var(--text-2)">${subtitle}</div>`;

  if (entries.length === 0) {
    return header + '<div class="text-muted" style="padding:8px 0">No entries found</div>';
  }

  const rows = entries.map(e => {
    const docId      = esc(e.doc_id_str ?? e.doc_id_hex);
    const isExhausted = maxRetries > 0 && e.retry_count >= maxRetries;
    const retryClass  = isExhausted ? 'bad' : e.retry_count > 0 ? 'warn' : '';
    return `
      <tr>
        <td style="font-family:monospace;font-size:11px">${esc(e.namespace)}</td>
        <td style="font-family:monospace;font-size:11px;color:var(--text-2)">${docId}</td>
        <td style="text-align:center">
          <span class="stat-val ${retryClass}" style="font-size:12px">${e.retry_count}</span>
        </td>
        <td class="vq-preview">${esc(e.text_preview)}</td>
        <td style="white-space:nowrap">
          ${isExhausted ? `<button class="btn btn-xs btn-accent" style="margin-right:4px"
                  title="Reset this entry so it will be re-indexed"
                  onclick="vqRetryEntry('${esc(e.namespace)}','${esc(e.doc_id_hex)}',this)">Re-index</button>` : ''}
          <button class="btn btn-xs btn-danger"
                  onclick="vqDeleteEntry('${esc(e.namespace)}','${esc(e.doc_id_hex)}',this)">
            Remove
          </button>
        </td>
      </tr>`;
  }).join('');

  const prevHandler = isNsMode ? `vqBrowseNs(${page - 1})` : `vqLoadRetried(${page - 1})`;
  const nextHandler = isNsMode ? `vqBrowseNs(${page + 1})` : `vqLoadRetried(${page + 1})`;

  const pagination = totalPages > 1 ? `
    <div class="vq-pagination">
      <button class="pagination-btn" ${page <= 1 ? 'disabled' : ''} onclick="${prevHandler}">← Prev</button>
      <span>Page ${page} of ${totalPages}</span>
      <button class="pagination-btn" ${page >= totalPages ? 'disabled' : ''} onclick="${nextHandler}">Next →</button>
    </div>` : '';

  return `
    ${header}
    <div style="overflow-x:auto">
      <table class="vq-table">
        <thead><tr>
          <th>Namespace</th>
          <th>Doc ID</th>
          <th style="text-align:center">Retries</th>
          <th>Text Preview</th>
          <th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${pagination}`;
}

async function vqDeleteEntry(ns, idHex, btn) {
  if (!confirm(`Remove queue entry for doc "${idHex}" in namespace "${ns}"?`)) return;
  btn.disabled = true;
  try {
    await Api.vectorQueueDeleteEntry(ns, idHex);
    btn.closest('tr').remove();
    toast('Queue entry removed');
  } catch (e) {
    toast('Failed to remove entry: ' + e.message, 'error');
    btn.disabled = false;
  }
}

async function vqRetryEntry(ns, idHex, btn) {
  btn.disabled = true;
  btn.textContent = '…';
  try {
    await Api.vectorQueueRetryEntry(ns, idHex);
    btn.textContent = 'Re-queued';
    btn.classList.replace('btn-accent', 'btn-ghost');
    toast('Entry re-queued for indexing');
  } catch (e) {
    toast('Failed to re-index entry: ' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Re-index';
  }
}


// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function init() {
  const saved = localStorage.getItem('minnal_base_url');
  // When served over HTTP (e.g. via Docker/nginx), default to the same origin so
  // nginx can proxy API calls — no manual configuration needed.
  // When opened as a file:// URL fall back to the direct API address.
  const defaultUrl = window.location.protocol !== 'file:'
    ? window.location.origin
    : 'http://localhost:8080';

  const url = saved ?? defaultUrl;
  state.baseUrl = url;
  document.getElementById('base-url-input').value = url;
  Api.setBaseUrl(url);
  await connect();
}

document.addEventListener('DOMContentLoaded', init);

// ── Enter-key submit ──────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const target = e.target;
  if (target.tagName !== 'INPUT' || target.type === 'checkbox' || target.type === 'radio') return;

  // Walk up through progressively wider containers, click the first primary button found.
  for (const selector of ['.form-row', '.sub-panel', '#modal-content', '.topbar-url']) {
    const container = target.closest(selector);
    if (!container) continue;
    const btn = container.querySelector('.btn-accent:not([disabled])');
    if (btn) { btn.click(); e.preventDefault(); return; }
  }
});

// ── Esc-key dismiss ───────────────────────────────────────────────────────────
// Any pop-up (incl. query-result payload views) shares the #modal overlay, so a
// single handler dismisses whichever one is open.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.getElementById('modal')?.classList.contains('open')) {
    closeModal();
    e.preventDefault();
  }
});
