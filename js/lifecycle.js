/**
 * lifecycle.js — a store's lifecycle in the UI: its state, its index jobs and
 * the lifecycle audit log.
 *
 * A store is `creating`, `created`, `index_maintenance` (an index job is
 * running: it takes requests but cannot be dropped) or `deleting`. Creating or
 * dropping a store, and every operation that builds or removes an index, runs
 * in the background on the server and answers 202 at once; the helpers here
 * wait for the state that follows, and the Admin → Lifecycle sub-tab shows the
 * jobs and the audit log of the store selected in the sidebar (or of every
 * store, with none selected).
 */

// ── States ────────────────────────────────────────────────────────────────────

const STORE_STATE_LABEL = {
  creating: 'creating',
  index_maintenance: 'maintenance',
  deleting: 'deleting',
};

const STORE_STATE_TIP = {
  creating: 'Being set up in the background; it takes requests once created.',
  index_maintenance: 'An index job is running: the store takes requests but cannot be dropped until its jobs end (Admin → Lifecycle).',
  deleting: 'Being dropped in the background; it refuses every request.',
};

/** A badge for a store that is not simply `created`; empty otherwise. A
 *  store whose create or drop the server gave up on (`parked`, the last
 *  error) gets a red badge saying so. */
function storeStateBadge(s) {
  const st = s?.state;
  if (!st || st === 'created') return '';
  if (s.parked) {
    const what = st === 'creating' ? 'setup failed' : 'drop failed';
    const tip = `${st === 'creating' ? 'Setup' : 'The drop'} failed every retry and is left until the server restarts`
      + `${st === 'creating' ? '; the store can be deleted' : ''}. Last error: ${s.parked}`;
    return `<span class="badge badge-error" title="${esc(tip)}">${esc(what)}</span>`;
  }
  return `<span class="badge badge-state badge-state-${esc(st)}" title="${esc(STORE_STATE_TIP[st] ?? st)}">${esc(STORE_STATE_LABEL[st] ?? st)}</span>`;
}

/**
 * Wait until store `ns` is in one of `wanted` (state names, or 'gone' for no
 * store), polling `GET /stores`. Resolves with the state reached, 'parked'
 * if the server gave up on the store's create or drop (it will not move on
 * by itself), or null after `timeoutMs`.
 */
async function waitForStoreState(ns, wanted, timeoutMs = 120000, onPoll = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const all = (await Api.listStores().catch(() => null)) ?? null;
    if (all) {
      const store = all.find(s => s.namespace === ns);
      if (onPoll) await onPoll(store);
      const st = store ? (store.state ?? 'created') : 'gone';
      if (wanted.includes(st)) return st;
      if (store?.parked) return 'parked';
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

/** The store's indexed fields, as one comparable string. */
const indexFieldsOf = (store) => (store?.indices ?? []).map(i => i.field).join(',');

/**
 * Wait until `ns` has no running index job (it is `created` again), then reload
 * the stores. A job changes the schema while it runs (a build lists its index
 * only once it has activated it, moments after the 202), so the stores are
 * reloaded whenever the index list moves: the new row appears and its build's
 * progress is shown while it runs.
 */
async function afterJobStarted(ns) {
  let seen = indexFieldsOf([...state.stores, ...state.kvStores].find(s => s.namespace === ns));
  await waitForStoreState(ns, ['created', 'gone'], undefined, async (store) => {
    const now = indexFieldsOf(store);
    if (now !== seen) { seen = now; await loadStores(); }
  });
  await loadStores();
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

/** Show the progress of every field build of `ns` that is running now. */
async function resumeBuildPolls(ns) {
  const r = await Api.storeJobs(ns).catch(() => null);
  for (const j of r?.jobs ?? []) {
    if (jobKind(j.job) === 'field_build' && ['running', 'pending'].includes(j.status)) {
      startProgressPoll(ns, j.job.slice('field_build:'.length));
    }
  }
}

/** The jobs a cancel may stop part-way (the others refuse it). */
const CANCELLABLE_JOBS = ['field_build', 'vector_enable', 'vector_reindex', 'partition_rebuild'];

const JOB_TIP = {
  field_build: 'Building a field index: indexing every stored document. Cancel drops the half-built index.',
  field_drop: 'Dropping a field index: the field becomes a plain attribute.',
  reindex_all: 'Dropping and rebuilding every field index (or dropping them all). Cannot be cancelled: its first step drops the old indexes.',
  vector_enable: 'Turning semantic search on: seeding the partition. Cancel removes what it seeded.',
  vector_cleanup: 'Turning semantic search off and removing the vector index. Cannot be cancelled.',
  vector_reindex: 'Re-queueing every document for embedding. Cancel stops at the next page; what is queued is embedded.',
  partition_rebuild: 'Re-clustering the vector partition from its codes. Cancel works until its plan is recorded.',
};

const jobKind = (name) => String(name).split(':')[0];
const isLiveJob = (j) => ['pending', 'running', 'cancelling'].includes(j.status);

function jobStatusBadge(status) {
  const cls = status === 'complete' ? 'badge-ok'
    : status === 'failed' ? 'badge-error'
    : status === 'cancelled' ? 'badge-unknown'
    : 'badge-state badge-state-index_maintenance';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

/** A job's progress, from its own record: a build's counts, a reindex's enqueued, a rebuild's report. */
function jobProgressHtml(j) {
  const p = j.progress ?? {};
  if (typeof p.total === 'number' && typeof p.indexed === 'number' && (p.total > 0 || j.status === 'complete')) {
    const pct = p.total > 0 ? Math.min(100, (p.indexed / p.total) * 100) : (j.status === 'complete' ? 100 : 0);
    return `<div class="progress-wrap" style="height:8px"><div class="progress-bar" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="progress-label">${fmt(p.indexed)} / ${fmt(p.total)}</div>`;
  }
  if (typeof p.enqueued === 'number') return `<span class="text-muted">${fmt(p.enqueued)} enqueued</span>`;
  if (p.report) return `<span class="text-muted">${fmt(p.report.postings_before)} → ${fmt(p.report.postings_after)} postings, ${fmt(p.report.chunks_moved)} chunks moved</span>`;
  if (p.phase) return `<span class="text-muted">${esc(p.phase)}${p.specs ? `, ${fmt(p.built ?? 0)} of ${fmt(p.specs.length)} built` : ''}</span>`;
  return '<span class="text-muted">—</span>';
}

const fmtTimeMs = (ms) => (ms ? new Date(ms).toLocaleString() : '—');

function jobRowsHtml(jobs, withNs) {
  return jobs.map(j => {
    const kind = jobKind(j.job);
    const ns = j.namespace ?? lifecycle.ns;
    const cancel = isLiveJob(j) && j.status !== 'cancelling' && CANCELLABLE_JOBS.includes(kind)
      ? `<button class="btn btn-xs btn-danger" onclick="cancelStoreJob('${esc(ns)}','${esc(j.job)}',this)">Cancel</button>`
      : '';
    return `<tr>
      ${withNs ? nsCell(ns, findStore(ns, 'kv') ? 'kv' : 'doc') : ''}
      <td class="text-mono" title="${esc(JOB_TIP[kind] ?? '')}">${esc(j.job)}</td>
      <td>${jobStatusBadge(j.status)}</td>
      <td style="min-width:160px">${jobProgressHtml(j)}</td>
      <td>${esc(fmtTimeMs(j.started_at_ms))}</td>
      <td>${esc(fmtTimeMs(j.updated_at_ms))}</td>
      <td class="text-muted">${esc(j.error ?? '')}</td>
      <td>${cancel}</td>
    </tr>`;
  }).join('');
}

function jobsTableHtml(jobs, withNs) {
  if (!jobs.length) return `<p class="text-muted">${withNs ? 'No index job is running in any store.' : 'This store has had no index job.'}</p>`;
  return `<div class="tbl-wrap"><table class="tbl">
    <thead><tr>${withNs ? '<th>Store</th>' : ''}<th>Job</th><th>Status</th><th>Progress</th><th>Started</th><th>Updated</th><th>Error</th><th></th></tr></thead>
    <tbody>${jobRowsHtml(jobs, withNs)}</tbody></table></div>`;
}

async function cancelStoreJob(ns, job, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…'; }
  try {
    await Api.cancelJob(ns, job);
    toast(`Cancel of ${job} asked for: it stops at its next batch and undoes its work`);
    refreshLifecycleJobs();
  } catch (e) {
    toast(e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Cancel'; }
  }
}

// ── Audit log ─────────────────────────────────────────────────────────────────

const AUDIT_EVENT_LABEL = {
  creating: 'create accepted',
  created: 'created',
  deleting: 'drop accepted',
  deleted: 'deleted',
  job_started: 'job started',
  job_cancel_requested: 'cancel asked',
  job_completed: 'job completed',
  job_failed: 'job failed',
  job_cancelled: 'job cancelled',
  job_withdrawn: 'job withdrawn',
  resumed: 'resumed after restart',
  task_parked: 'given up on',
  governor_stopped: 'governor stopped',
};

const AUDIT_EVENT_CLASS = {
  created: 'badge-ok', job_completed: 'badge-ok',
  job_failed: 'badge-error', task_parked: 'badge-error', governor_stopped: 'badge-error',
  deleted: 'badge-unknown', job_cancelled: 'badge-unknown', job_withdrawn: 'badge-unknown',
};

function auditRowsHtml(records, withNs) {
  return records.map(r => `<tr>
    <td>${esc(fmtTimeMs(r.at_ms))}</td>
    ${withNs ? (r.namespace ? (findStore(r.namespace, 'doc') || findStore(r.namespace, 'kv')
      ? nsCell(r.namespace, findStore(r.namespace, 'kv') ? 'kv' : 'doc')
      : `<td class="text-mono text-muted" title="No longer exists">${esc(r.namespace)}</td>`) : '<td>—</td>') : ''}
    <td><span class="badge ${AUDIT_EVENT_CLASS[r.event] ?? 'badge-state badge-state-index_maintenance'}">${esc(AUDIT_EVENT_LABEL[r.event] ?? r.event)}</span></td>
    <td class="text-mono">${esc(r.job ?? '')}</td>
    <td class="text-mono">${esc(r.subject ?? '')}</td>
    <td class="text-muted">${esc(r.detail ?? '')}</td>
  </tr>`).join('');
}

// ── Admin → Lifecycle sub-tab ─────────────────────────────────────────────────

const lifecycle = { ns: null, audit: [], cursor: null, poll: null };

/** Render the Lifecycle sub-tab: jobs, then the audit log, for the sidebar's store or every store. */
async function loadAdminLifecyclePanel() {
  const panel = document.getElementById('admin-lifecycle-panel');
  if (!panel) return;
  const s = state.selectedStore && !isSystemStore() ? state.selectedStore : null;
  lifecycle.ns = s?.namespace ?? null;
  lifecycle.audit = [];
  lifecycle.cursor = null;
  panel.innerHTML = `
    <div class="section-header"><span class="section-title">${s ? `INDEX JOBS — ${esc(s.namespace)} ${storeStateBadge(s)}` : 'RUNNING INDEX JOBS — EVERY STORE'}</span>
      <button class="btn btn-xs btn-ghost" onclick="refreshLifecycleJobs()">↻ Refresh</button></div>
    <p class="text-muted">${s
      ? 'Each kind of job (and field) shows its latest run. A store with a running job takes requests but cannot be dropped; cancel a job to stop it early.'
      : 'Select a store in the sidebar to see its jobs, running and ended.'}</p>
    <div id="lifecycle-jobs"><div class="spinner"></div></div>
    <div class="section-header" style="margin-top:22px"><span class="section-title">LIFECYCLE AUDIT LOG${s ? ` — ${esc(s.namespace)}` : ''}</span>
      <button class="btn btn-xs btn-ghost" onclick="loadAdminLifecyclePanel()">↻ Refresh</button></div>
    <p class="text-muted">Every store creation and drop, every index job's start, cancel and end, work a restart picked up, and anything the server gave up on, newest first. Records outlive the stores they describe and are kept for the server's <code>[lifecycle] audit_retention_days</code>.</p>
    <div id="lifecycle-audit"><div class="spinner"></div></div>`;
  await Promise.all([refreshLifecycleJobs(), loadMoreAudit()]);
}

/** Reload the jobs table; keep polling while a job runs and the sub-tab is open. */
async function refreshLifecycleJobs() {
  const el = document.getElementById('lifecycle-jobs');
  if (!el) return;
  clearTimeout(lifecycle.poll);
  try {
    let jobs;
    if (lifecycle.ns) {
      const r = await Api.storeJobs(lifecycle.ns);
      jobs = r?.jobs ?? [];
      el.innerHTML = jobsTableHtml(jobs, false);
    } else {
      jobs = (await Api.liveJobs()) ?? [];
      el.innerHTML = jobsTableHtml(jobs, true);
    }
    if (jobs.some(isLiveJob) && state.activeTab === 'admin' && state.adminTab === 'lifecycle') {
      lifecycle.poll = setTimeout(() => {
        refreshLifecycleJobs();
        if (!jobs.some(isLiveJob)) loadStores();
      }, 1500);
    } else if (lifecycle.wasLive) {
      loadStores(); // a job ended: the store's state changed
    }
    lifecycle.wasLive = jobs.some(isLiveJob);
  } catch (e) {
    el.innerHTML = `<p class="text-muted">Cannot read jobs: ${esc(e.message)}</p>`;
  }
}

/** Load the next page of the audit log. */
async function loadMoreAudit() {
  const el = document.getElementById('lifecycle-audit');
  if (!el) return;
  try {
    const r = await Api.lifecycleAudit({ namespace: lifecycle.ns, limit: 50, cursor: lifecycle.cursor });
    lifecycle.audit.push(...(r?.results ?? []));
    lifecycle.cursor = r?.next_cursor ?? null;
    const withNs = !lifecycle.ns;
    el.innerHTML = lifecycle.audit.length
      ? `<div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>When</th>${withNs ? '<th>Store</th>' : ''}<th>Event</th><th>Job</th><th>Subject</th><th>Detail</th></tr></thead>
          <tbody>${auditRowsHtml(lifecycle.audit, withNs)}</tbody></table></div>
         ${lifecycle.cursor ? '<button class="btn btn-xs btn-ghost" style="margin-top:8px" onclick="loadMoreAudit()">Load more</button>' : ''}`
      : '<p class="text-muted">No lifecycle events recorded.</p>';
  } catch (e) {
    el.innerHTML = `<p class="text-muted">Cannot read the audit log: ${esc(e.message)}</p>`;
  }
}
