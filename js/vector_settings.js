/**
 * vector_settings.js — a store's vector-index settings (its schema's
 * `vector_index`): shown on the Schema tab, edited where the server allows it,
 * and set when semantic search is first enabled.
 *
 * What may change (minnal_db `doc_store/vector_settings.rs`):
 *   embedding_model, embedding_dim, chunking.*  fixed once semantic search is on
 *   quantisation.*                              read-only (rotation_seed may be
 *                                               chosen at enable time, then fixed)
 *   search.*, maintenance.*                     changeable any time:
 *       PATCH /stores/{ns}/schema {"op":"update_vector_search", search, maintenance}
 *
 * At enable time (create store, enable_vector_index) every field is optional:
 * the server fills omitted ones from its defaults and saves the filled-in
 * values, so a schema read back shows everything in force.
 *
 * Tooltips reuse VTIP (vector_ops.js).
 */

const VSET_GROUPS = [
  {
    id: 'embedding', title: 'Embedding and chunking', rule: 'fixed',
    ruleTip: 'Fixed for the life of the store: they decide what the stored vectors are. To change them, drop the vector index and enable it again.',
    fields: [
      { key: 'embedding_model', path: ['embedding_model'], type: 'model' },
      { key: 'embedding_dim',   path: ['embedding_dim'],   type: 'int' },
      { key: 'window_size',     path: ['chunking', 'window_size'],  type: 'int' },
      { key: 'sliding_size',    path: ['chunking', 'sliding_size'], type: 'int' },
    ],
  },
  {
    id: 'quantisation', title: 'Quantisation', rule: 'read-only',
    ruleTip: 'Chosen by minnal. The rotation seed can be given when semantic search is enabled, then stays fixed.',
    fields: [
      { key: 'pass1_bits',    path: ['quantisation', 'pass1_bits'],    type: 'int' },
      { key: 'pass2_bits',    path: ['quantisation', 'pass2_bits'],    type: 'int' },
      { key: 'pass2_centre',  path: ['quantisation', 'pass2_centre'],  type: 'str' },
      { key: 'rotation_seed', path: ['quantisation', 'rotation_seed'], type: 'seed' },
    ],
  },
  {
    id: 'search', title: 'Search defaults', rule: 'editable',
    ruleTip: 'Change any time; each search can also override them.',
    fields: [
      { key: 'min_probes',            path: ['search', 'min_probes'],            type: 'int' },
      { key: 'max_probes',            path: ['search', 'max_probes'],            type: 'int' },
      { key: 'first_pass_top_k',      path: ['search', 'first_pass_top_k'],      type: 'int' },
      { key: 'top_k',                 path: ['search', 'top_k'],                 type: 'int' },
    ],
  },
  {
    id: 'maintenance', title: 'Partition maintenance', rule: 'editable',
    ruleTip: 'Change any time; later splits and merges use the new values.',
    fields: [
      { key: 'target_posting_size',  path: ['maintenance', 'target_posting_size'],  type: 'int' },
      { key: 'reassign_range',       path: ['maintenance', 'reassign_range'],       type: 'int' },
      { key: 'merge_ratio',          path: ['maintenance', 'merge_ratio'],          type: 'ratio' },
      { key: 'skip_uncertain_moves', path: ['maintenance', 'skip_uncertain_moves'], type: 'bool' },
      { key: 'split_samples',        path: ['maintenance', 'split_samples'],        type: 'int' },
      { key: 'split_init_trials',    path: ['maintenance', 'split_init_trials'],    type: 'int' },
      { key: 'split_max_iters',      path: ['maintenance', 'split_max_iters'],      type: 'int' },
      { key: 'split_lambda_factor',  path: ['maintenance', 'split_lambda_factor'],  type: 'ratio' },
    ],
  },
];

const VSET_RULE_BADGE = {
  'fixed':     '<span class="badge badge-attr">🔒 fixed</span>',
  'read-only': '<span class="badge badge-attr">read-only</span>',
  'editable':  '<span class="badge badge-indexed">editable</span>',
};

/** Server-wide vector settings (defaults for new stores, allowed models), cached. */
const vsetState = { server: null, loading: null };

function loadVectorServerSettings() {
  if (vsetState.server) return Promise.resolve(vsetState.server);
  if (!vsetState.loading) {
    vsetState.loading = Api.vectorServerSettings()
      .then(s => { vsetState.server = s; return s; })
      .catch(() => null)
      .finally(() => { vsetState.loading = null; });
  }
  return vsetState.loading;
}

const vsetGet = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);

function vsetSet(obj, path, value) {
  let o = obj;
  path.slice(0, -1).forEach(k => { o = o[k] ??= {}; });
  o[path[path.length - 1]] = value;
}

function vsetFmt(f, v) {
  if (v == null) return '—';
  if (f.type === 'bool') return v ? 'on' : 'off';
  if (f.zeroIsOff && Number(v) === 0) return 'off';
  if (typeof v === 'number') return Number.isInteger(v) ? fmt(v) : String(+v.toFixed(4));
  return esc(String(v));
}

/** The default a new store would get, where the server reports one. */
function vsetDefault(f) {
  const d = vsetState.server?.namespace_defaults;
  if (!d) return undefined;
  if (f.path[0] !== 'search' && f.path[0] !== 'maintenance') return undefined;
  const v = vsetGet(d, f.path);
  // The server reports an unset fraction as null: scaling off.
  return v == null && f.zeroIsOff ? 0 : v;
}

// ── Schema tab: the settings in force ────────────────────────────────────────
/** The VECTOR INDEX SETTINGS section for a semantic-search store (doc or KV). */
function renderVectorSettingsSection(s) {
  const vi = s?.vector_index;
  if (!s?.semantic_search_enabled || !vi) return '';
  const card = (g) => `
    <div class="admin-card">
      <div class="admin-card-title vset-card-title">
        <span>${esc(g.title.toUpperCase())}</span>
        <span title="${esc(g.ruleTip)}">${VSET_RULE_BADGE[g.rule]}</span>
      </div>
      ${g.fields.map(f => `
        <div class="stat-row"><span class="stat-key" title="${esc(vt(f.key))}">${f.key}</span>
          <span class="stat-val">${vsetFmt(f, vsetGet(vi, f.path))}</span></div>`).join('')}
    </div>`;
  return `
    <div class="section">
      <div class="section-header">
        <span class="section-title" title="The store's vector_index, as saved in its schema and included in Export Schema.">VECTOR INDEX SETTINGS</span>
        <button class="btn btn-sm btn-accent" onclick="showEditVectorSettingsModal('${esc(s.namespace)}')"
                title="Change the search defaults and partition maintenance settings">✎ Edit Search &amp; Maintenance</button>
      </div>
      <div class="admin-grid vset-grid">${VSET_GROUPS.map(card).join('')}</div>
    </div>`;
}

// ── Inputs ───────────────────────────────────────────────────────────────────
/**
 * One input for field `f`. `value` prefills it (editing); `placeholder` hints
 * the default when it is left empty (enable time).
 */
function vsetInput(prefix, f, value, placeholder) {
  const id = `${prefix}-${f.key}`;
  const ph = placeholder == null ? '' : `placeholder="${esc(f.type === 'bool' ? '' : vsetFmt(f, placeholder))}"`;
  if (f.type === 'bool') {
    // Three states at enable time (default / on / off); two when editing.
    if (value === undefined) {
      return `<select id="${id}">
        <option value="">default${placeholder != null ? ` (${placeholder ? 'on' : 'off'})` : ''}</option>
        <option value="true">on</option><option value="false">off</option></select>`;
    }
    return `<select id="${id}"><option value="true" ${value ? 'selected' : ''}>on</option>
      <option value="false" ${!value ? 'selected' : ''}>off</option></select>`;
  }
  const step = f.type === 'ratio' ? 'any' : '1';
  const kind = f.type === 'int' || f.type === 'ratio' ? `type="number" min="0" step="${step}"` : 'type="text"';
  return `<input id="${id}" ${kind} value="${value == null ? '' : esc(String(value))}" ${ph} />`;
}

/** Read field `f`'s input: undefined when empty, else the typed value. */
function vsetRead(prefix, f) {
  const el = document.getElementById(`${prefix}-${f.key}`);
  if (!el) return undefined;
  const raw = el.value.trim();
  if (raw === '') return undefined;
  if (f.type === 'bool') return raw === 'true';
  if (f.type === 'int') return Number.parseInt(raw, 10);
  if (f.type === 'ratio') return Number.parseFloat(raw);
  return raw;
}

function vsetFieldRow(prefix, f, value, placeholder) {
  return `<label class="vset-field" title="${esc(vt(f.key))}">
    <span>${f.key}</span>${vsetInput(prefix, f, value, placeholder)}</label>`;
}

// ── Edit modal: search + maintenance ─────────────────────────────────────────
function showEditVectorSettingsModal(ns) {
  const s = [...state.stores, ...state.kvStores].find(x => x.namespace === ns);
  const vi = s?.vector_index;
  if (!vi) { toast(`${ns} has no vector-index settings`, 'error'); return; }
  const editable = VSET_GROUPS.filter(g => g.rule === 'editable');
  openModal(`
    <div class="modal-title">Vector Index Settings — ${esc(ns)}</div>
    <p class="text-muted" style="margin:0 0 12px">
      Search defaults apply to every later search (each search can still override them).
      Maintenance settings apply to later splits and merges. The embedding model, dimension
      and chunking are fixed; to change them, drop the vector index and enable it again.
    </p>
    ${editable.map(g => `
      <div class="modal-section">
        <div class="modal-section-title">${esc(g.title.toUpperCase())}</div>
        <div class="vset-form">${g.fields.map(f => vsetFieldRow('vset-edit', f, vsetGet(vi, f.path))).join('')}</div>
      </div>`).join('')}
    <div id="vset-edit-error"></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-accent" onclick="submitEditVectorSettings('${esc(ns)}')">Save</button>
    </div>
  `);
}

async function submitEditVectorSettings(ns) {
  const s = [...state.stores, ...state.kvStores].find(x => x.namespace === ns);
  const vi = s?.vector_index ?? {};
  const body = { op: 'update_vector_search', search: {} };
  const changed = [];
  VSET_GROUPS.filter(g => g.rule === 'editable').forEach(g => g.fields.forEach(f => {
    const v = vsetRead('vset-edit', f);
    if (v === undefined || Number.isNaN(v)) return;
    if (v === vsetGet(vi, f.path)) return;
    vsetSet(body, f.path, v);
    changed.push(f.key);
  }));
  if (!changed.length) { toast('Nothing changed'); closeModal(); return; }
  const err = document.getElementById('vset-edit-error');
  const btn = document.querySelector('#modal-content .btn-accent');
  btn.disabled = true;
  try {
    await Api.amendSchema(ns, body);
    closeModal();
    toast(`Updated ${changed.join(', ')}`);
    await loadStores();
  } catch (e) {
    if (err) err.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
    btn.disabled = false;
  }
}

// ── Enable time: create store, enable vector index ───────────────────────────
/**
 * Settings fields for a store that is about to enable semantic search. Every
 * field is optional except the model (prefilled with the default); empty ones
 * take the server's defaults.
 */
function renderVectorSpecForm(prefix) {
  const fixed = VSET_GROUPS.find(g => g.id === 'embedding').fields;
  const seed = VSET_GROUPS.find(g => g.id === 'quantisation').fields.find(f => f.key === 'rotation_seed');
  const later = VSET_GROUPS.filter(g => g.rule === 'editable');
  return `
    <div id="${prefix}-vset" class="vset-spec">
      <div class="text-muted" style="font-size:12px;margin-bottom:8px">
        Model, dimension and chunking are <strong>fixed</strong> once the store is created.
        Leave a field empty to use the server's default.
      </div>
      <div class="vset-form">
        <label class="vset-field" title="${esc(vt('embedding_model'))}"><span>embedding_model</span>
          <select id="${prefix}-embedding_model" onchange="onVectorSpecModelChange('${prefix}')">
            <option value="gemma">gemma</option>
          </select></label>
        ${fixed.filter(f => f.key !== 'embedding_model').map(f => vsetFieldRow(prefix, f, undefined,
          { embedding_dim: 768, window_size: 4, sliding_size: 2 }[f.key])).join('')}
      </div>
      <details class="vset-more">
        <summary>Search, maintenance and rotation seed (optional; changeable later except the seed)</summary>
        ${later.map(g => `
          <div class="modal-section-title" style="margin-top:10px">${esc(g.title.toUpperCase())}</div>
          <div class="vset-form">${g.fields.map(f => vsetFieldRow(prefix, f, undefined, vsetDefault(f))).join('')}</div>`).join('')}
        <div class="modal-section-title" style="margin-top:10px">QUANTISATION</div>
        <div class="vset-form">${vsetFieldRow(prefix, seed, undefined, '0x6d696e6e616c0001')}</div>
      </details>
    </div>`;
}

/** Fill the model list and default placeholders once the server has answered. */
async function fillVectorSpecForm(prefix) {
  const srv = await loadVectorServerSettings();
  const sel = document.getElementById(`${prefix}-embedding_model`);
  if (!sel) return;
  const models = Object.entries(srv?.supported_models ?? {});
  if (models.length) {
    sel.innerHTML = models.map(([m, dim]) =>
      `<option value="${esc(m)}" data-dim="${dim}" ${m === 'gemma' ? 'selected' : ''}>${esc(m)} (${dim}-d)</option>`).join('');
  } else {
    // No allow-list: any model the embedding service serves.
    sel.outerHTML = `<input id="${prefix}-embedding_model" type="text" value="gemma" />`;
  }
  VSET_GROUPS.filter(g => g.rule === 'editable').forEach(g => g.fields.forEach(f => {
    const el = document.getElementById(`${prefix}-${f.key}`);
    const d = vsetDefault(f);
    if (!el || d == null) return;
    if (el.tagName === 'SELECT') el.options[0].textContent = `default (${d ? 'on' : 'off'})`;
    else el.placeholder = vsetFmt(f, d);
  }));
  onVectorSpecModelChange(prefix);
}

function onVectorSpecModelChange(prefix) {
  const sel = document.getElementById(`${prefix}-embedding_model`);
  const dim = sel?.selectedOptions?.[0]?.dataset?.dim;
  const dimEl = document.getElementById(`${prefix}-embedding_dim`);
  if (dimEl && dim) dimEl.placeholder = dim;
}

/** The `vector_index` spec from the form: only the fields that were filled in. */
function collectVectorSpec(prefix) {
  const spec = {};
  const all = VSET_GROUPS.flatMap(g => g.fields)
    .filter(f => f.type !== 'model' && (f.path[0] !== 'quantisation' || f.key === 'rotation_seed'));
  const model = document.getElementById(`${prefix}-embedding_model`)?.value.trim();
  if (model) spec.embedding_model = model;
  for (const f of all) {
    const v = vsetRead(prefix, f);
    if (v === undefined) continue;
    if (Number.isNaN(v)) throw new Error(`${f.key} must be a number`);
    vsetSet(spec, f.path, v);
  }
  return spec;
}
