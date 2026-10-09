/**
 * api.js — thin wrapper around the Minnal Doc Store REST API.
 *
 * All functions are async and throw an Error with a human-readable
 * message on failure.  Callers are responsible for catching errors.
 */
const Api = (() => {
  let baseUrl = 'http://localhost:8080';

  function setBaseUrl(url) {
    baseUrl = url.replace(/\/$/, '');
  }

  // ── Core fetch helper ──────────────────────────────────────────────
  async function req(method, path, body) {
    const url = `${baseUrl}${path}`;
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    let resp;
    try {
      resp = await fetch(url, opts);
    } catch (e) {
      throw new Error(`Network error: ${e.message}`);
    }

    if (resp.status === 204) return null;

    let data;
    try { data = await resp.json(); } catch { data = null; }

    if (!resp.ok) {
      const msg = data?.error ?? `HTTP ${resp.status} ${resp.statusText}`;
      throw new Error(msg);
    }
    return data;
  }

  // ── Store lifecycle ────────────────────────────────────────────────
  // Doc and KV stores share a single /stores path. `listStores` returns both
  // kinds; each entry carries a `store_type` ("doc"/"kv") to tell them apart.
  // `createStore` dispatches on the payload's mandatory `store_type`.
  const listStores   = ()         => req('GET',    '/stores');
  const createStore  = (schema)   => req('POST',   '/stores', schema);
  const deleteStore  = (ns)       => req('DELETE', `/stores/${ns}`);
  const amendSchema  = (ns, op)   => req('PATCH',  `/stores/${ns}/schema`, op);

  // ── Index management (per-store) ───────────────────────────────────
  const addIndex  = (ns, spec)  => req('POST',   `/stores/${ns}/indices`, spec);
  const dropIndex = (ns, field) => req('DELETE', `/stores/${ns}/indices/${field}`);

  // ── Document CRUD ──────────────────────────────────────────────────
  const getDoc    = (ns, id)       => req('GET',    `/stores/${ns}/docs/${encodeURIComponent(id)}`);
  const putDoc    = (ns, id, doc)  => req('PUT',    `/stores/${ns}/docs/${encodeURIComponent(id)}`, doc);
  const deleteDoc = (ns, id)       => req('DELETE', `/stores/${ns}/docs/${encodeURIComponent(id)}`);

  const rangeScan = (ns, start, end, cursor, limit) => {
    const params = new URLSearchParams({ start });
    if (end)    params.set('end',    end);
    if (cursor) params.set('cursor', cursor);
    if (limit)  params.set('limit',  limit);
    return req('GET', `/stores/${ns}/docs?${params}`);
  };

  const prefixScan = (ns, prefix, cursor, limit) => {
    const params = new URLSearchParams({ prefix });
    if (cursor) params.set('cursor', cursor);
    if (limit)  params.set('limit',  limit);
    return req('GET', `/stores/${ns}/docs/prefix?${params}`);
  };

  const query = (ns, predicate, pageNo, pageSize) =>
    req('POST', `/stores/${ns}/query`, {
      predicate,
      ...(pageNo   ? { page_no:   pageNo   } : {}),
      ...(pageSize ? { page_size: pageSize } : {}),
    });

  // ── KV CRUD ───────────────────────────────────────────────────────
  // KV data plane lives under the shared /stores/{ns}/kv prefix.
  const getKv    = (ns, key)        => req('GET',    `/stores/${ns}/kv/${encodeURIComponent(key)}`);
  const putKv    = (ns, key, value) => req('PUT',    `/stores/${ns}/kv/${encodeURIComponent(key)}`, value);
  const deleteKv = (ns, key)        => req('DELETE', `/stores/${ns}/kv/${encodeURIComponent(key)}`);

  const kvRangeScan = (ns, start, end, cursor, limit) => {
    const p = new URLSearchParams({ start });
    if (end)    p.set('end',    end);
    if (cursor) p.set('cursor', cursor);
    if (limit)  p.set('limit',  limit);
    return req('GET', `/stores/${ns}/kv?${p}`);
  };

  const kvPrefixScan = (ns, prefix, cursor, limit) => {
    const p = new URLSearchParams({ prefix });
    if (cursor) p.set('cursor', cursor);
    if (limit)  p.set('limit',  limit);
    return req('GET', `/stores/${ns}/kv/prefix?${p}`);
  };

  // ── KV semantic search ─────────────────────────────────────────────
  const kvSemanticSearch = (ns, query, topK, pageNo, pageSize) =>
    req('POST', `/stores/${ns}/kv/semantic-search`, {
      query,
      ...(topK     ? { top_k:     topK     } : {}),
      ...(pageNo   ? { page_no:   pageNo   } : {}),
      ...(pageSize ? { page_size: pageSize } : {}),
    });

  // ── Semantic search ────────────────────────────────────────────────
  const semanticSearch = (ns, query, topK, pageNo, pageSize) =>
    req('POST', `/stores/${ns}/semantic-search`, {
      query,
      ...(topK     ? { top_k:     topK     } : {}),
      ...(pageNo   ? { page_no:   pageNo   } : {}),
      ...(pageSize ? { page_size: pageSize } : {}),
    });

  const semanticSearchFiltered = (ns, query, predicate, topK, pageNo, pageSize) =>
    req('POST', `/stores/${ns}/semantic-search/filtered`, {
      query,
      predicate,
      ...(topK     ? { top_k:     topK     } : {}),
      ...(pageNo   ? { page_no:   pageNo   } : {}),
      ...(pageSize ? { page_size: pageSize } : {}),
    });

  // ── Admin Stores ───────────────────────────────────────────────────
  // Import/export are unified across kinds: the import endpoint dispatches on the
  // schema's `store_type`, and export resolves the kind from the stored schema.
  const storeRowCount    = (ns)    => req('GET',  `/admin/stores/${encodeURIComponent(ns)}/row-count`);
  const importStoreSchema = (body) => req('POST', '/admin/stores/import', body);

  async function exportSchema(ns) {
    const url = `${baseUrl}/admin/stores/${encodeURIComponent(ns)}/schema/export`;
    let resp;
    try { resp = await fetch(url); } catch (e) { throw new Error(`Network error: ${e.message}`); }
    if (!resp.ok) {
      let data; try { data = await resp.json(); } catch { data = null; }
      throw new Error(data?.error ?? `HTTP ${resp.status} ${resp.statusText}`);
    }
    return resp.blob();
  }

  // ── Admin Storage ──────────────────────────────────────────────────
  const health       = ()  => req('GET',  '/admin/storage/health');
  const stats        = ()  => req('GET',  '/admin/storage/stats');
  const opsMetrics   = ()  => req('GET',  '/admin/storage/ops-metrics');
  const opsMetricsByNamespace = () => req('GET', '/admin/storage/ops-metrics/by-namespace');
  const indexWaste   = ()  => req('GET',  '/admin/storage/index-waste');
  const wal          = ()  => req('GET',  '/admin/storage/wal');
  const lsm          = ()  => req('GET',  '/admin/storage/lsm');
  const valueLog     = ()  => req('GET',  '/admin/storage/value-log');
  const namespaces   = ()  => req('GET',  '/admin/storage/namespaces');
  const physicalNamespaces = ()  => req('GET',  '/admin/storage/namespaces/physical');
  const systemStores    = ()   => req('GET',  '/admin/storage/system/stores');
  const systemStoreMeta = (ns) => req('GET',  `/admin/storage/system/stores/${encodeURIComponent(ns)}/meta`);
  // Unified across kinds; the KV response still carries key_type/value_type.
  const storeKvMeta     = (ns) => req('GET',  `/admin/storage/stores/${encodeURIComponent(ns)}/kv-meta`);
  const triggerGc    = ()  => req('POST', '/admin/storage/gc');
  const triggerWalGc = ()  => req('POST', '/admin/storage/gc/wal');
  const compact      = ()  => req('POST', '/admin/storage/compact');
  const indexCheckpoint = ()  => req('POST', '/admin/storage/index-checkpoint');

  // ── Admin Indices — query embedding cache ─────────────────────────
  const clearQueryEmbeddingCache = () => req('DELETE', '/admin/indices/vector/query-cache');
  const vectorReconcile          = () => req('POST',   '/admin/indices/vector/reconcile');

  // ── Admin Indices — vector corruption metrics ─────────────────────
  const vectorCorruptionMetrics = () => req('GET', '/admin/indices/vector/corruption-metrics');

  // ── Admin Indices — per-field blob stats (404 if not active) ──────
  const fieldBlobStats = (ns, field) =>
    req('GET', `/admin/indices/${encodeURIComponent(ns)}/${encodeURIComponent(field)}/blob-stats`);

  // ── Admin Indices — row map (dense row IDs for field indices) ─────
  // ids_allocated / live_docs / dead_ids / bytes_on_disk; counts live docs
  // with a key scan, so call it on demand rather than on every refresh.
  const rowmapStats = (ns) =>
    req('GET', `/admin/indices/${encodeURIComponent(ns)}/rowmap`);

  // ── Admin Indices — field index health / repair ───────────────────
  // health: per-field checkpoint offset, active flag, and any outstanding gap.
  // repair: replays the gap's worklist (or rebuilds the field) and clears it.
  const indexHealth = (ns) =>
    req('GET', `/admin/indices/${encodeURIComponent(ns)}/health`);
  const attributeRepair = (ns, field) =>
    req('POST', `/admin/indices/${encodeURIComponent(ns)}/attribute/${encodeURIComponent(field)}/repair`);

  // ── Admin Indices — single-document reindex ───────────────────────
  const attributeReindexDoc = (ns, field, docId) =>
    req('POST', `/admin/indices/${encodeURIComponent(ns)}/attribute/${encodeURIComponent(field)}/reindex/${encodeURIComponent(docId)}`);
  const vectorReindexDoc = (ns, docId) =>
    req('POST', `/admin/indices/${encodeURIComponent(ns)}/vector/reindex/${encodeURIComponent(docId)}`);

  // ── Admin Indices — progress monitoring ────────────────────────────
  const indicesProgress   = ()   => req('GET', '/admin/indices/progress');
  const indicesProgressNs = (ns) => req('GET', `/admin/indices/${encodeURIComponent(ns)}/progress`);

  // ── Admin Indices — attribute bulk operations (async 202) ──────────
  const attributeReindexAll = (ns) => req('POST',   `/admin/indices/${encodeURIComponent(ns)}/attribute/reindex-all`);
  const attributeDropAll    = (ns) => req('DELETE', `/admin/indices/${encodeURIComponent(ns)}/attribute/drop-all`);

  // ── Admin Indices — vector bulk operations (async 202) ────────────
  const vectorReindexAll    = (ns) => req('POST',   `/admin/indices/${encodeURIComponent(ns)}/vector/reindex-all`);
  const vectorReindexFailed = (ns) => req('POST',   `/admin/indices/${encodeURIComponent(ns)}/vector/reindex-failed`);
  const vectorDropAll       = (ns) => req('DELETE', `/admin/indices/${encodeURIComponent(ns)}/vector/drop-all`);

  // ── Vector index queue — global views ─────────────────────────────
  const vectorQueueSummary = () => req('GET', '/admin/indices/vector/queue/summary');

  const vectorQueueRetried = (pageNo, pageSize) => {
    const p = new URLSearchParams();
    if (pageNo)   p.set('page_no',   pageNo);
    if (pageSize) p.set('page_size', pageSize);
    return req('GET', `/admin/indices/vector/queue/retried?${p}`);
  };

  // ── Vector index queue — per-namespace views ───────────────────────
  const vectorQueueByNamespace = (ns, pageNo, pageSize) => {
    const p = new URLSearchParams();
    if (pageNo)   p.set('page_no',   pageNo);
    if (pageSize) p.set('page_size', pageSize);
    return req('GET', `/admin/indices/${encodeURIComponent(ns)}/vector/queue?${p}`);
  };

  const vectorQueueRetriedByNamespace = (ns, pageNo, pageSize) => {
    const p = new URLSearchParams();
    if (pageNo)   p.set('page_no',   pageNo);
    if (pageSize) p.set('page_size', pageSize);
    return req('GET', `/admin/indices/${encodeURIComponent(ns)}/vector/queue/retried?${p}`);
  };

  // ── Vector index queue — per-entry operations ─────────────────────
  const vectorQueueGetEntry    = (ns, idHex) => req('GET',    `/admin/indices/${encodeURIComponent(ns)}/vector/queue/${encodeURIComponent(idHex)}`);
  const vectorQueueDeleteEntry = (ns, idHex) => req('DELETE', `/admin/indices/${encodeURIComponent(ns)}/vector/queue/${encodeURIComponent(idHex)}`);
  const vectorQueueRetryEntry  = (ns, idHex) => req('POST',   `/admin/indices/${encodeURIComponent(ns)}/vector/queue/${encodeURIComponent(idHex)}/retry`);

  return {
    setBaseUrl,
    // stores (doc + KV, dispatched on store_type)
    listStores, createStore, deleteStore, amendSchema,
    // admin store ops (unified across kinds)
    storeRowCount, importStoreSchema, exportSchema,
    // indices (per-store)
    addIndex, dropIndex,
    // docs
    getDoc, putDoc, deleteDoc, rangeScan, prefixScan, query,
    // doc semantic
    semanticSearch, semanticSearchFiltered,
    // kv crud
    getKv, putKv, deleteKv, kvRangeScan, kvPrefixScan,
    // kv semantic
    kvSemanticSearch,
    // admin storage
    health, stats, opsMetrics, opsMetricsByNamespace, indexWaste, wal, lsm, valueLog, namespaces, physicalNamespaces,
    systemStores, systemStoreMeta, storeKvMeta,
    triggerGc, triggerWalGc, compact, indexCheckpoint,
    // admin indices — cache / reconcile
    clearQueryEmbeddingCache, vectorReconcile,
    // admin indices — corruption / blob stats / single-doc reindex
    vectorCorruptionMetrics, fieldBlobStats, attributeReindexDoc, vectorReindexDoc,
    // admin indices — field index health / repair
    indexHealth, attributeRepair, rowmapStats,
    // admin indices — progress
    indicesProgress, indicesProgressNs,
    // admin indices — attribute ops
    attributeReindexAll, attributeDropAll,
    // admin indices — vector ops
    vectorReindexAll, vectorReindexFailed, vectorDropAll,
    // vector queue — global
    vectorQueueSummary, vectorQueueRetried,
    // vector queue — per-namespace
    vectorQueueByNamespace, vectorQueueRetriedByNamespace,
    // vector queue — per-entry
    vectorQueueGetEntry, vectorQueueDeleteEntry, vectorQueueRetryEntry,
  };
})();
