#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const lockfile = require('proper-lockfile');

const { sanitize } = require('./sanitizer');

const IMMUNE_DIR = __dirname;
const DB_PATH = path.join(IMMUNE_DIR, 'immune.sqlite');
const JSON_AB = path.join(IMMUNE_DIR, 'immune_memory.json');
const JSON_CS = path.join(IMMUNE_DIR, 'cheatsheet_memory.json');
const MIGRATION_FILE = path.join(IMMUNE_DIR, 'migration_state.json');
const CONTEXT_DIR = path.join(IMMUNE_DIR, 'context');
const ARCHIVE_DIR = path.join(CONTEXT_DIR, 'archive');
const MEMORY_MD = path.join(IMMUNE_DIR, '..', 'MEMORY.md'); // override via MEMORY_MD env var
const USER_MD = path.join(IMMUNE_DIR, 'USER.md');
const ARCHIVE_AB = path.join(IMMUNE_DIR, 'archived_antibodies.json');
const ARCHIVE_CS = path.join(IMMUNE_DIR, 'archived_strategies.json');
const LOCK_FILE = DB_PATH + '.lock';
const MAX_CHUNKS = 2000;
const RETENTION_DAYS = 90;
const LIMITS = { max_antibodies: 500, max_strategies: 300, max_sqlite_mb: 50, max_context_files: 500 };

// ── Deduplication Config ────────────────────────────────

const DEDUP_THRESHOLD_JACCARD = 0.55;
const DEDUP_THRESHOLD_EMBEDDING = 0.7;    // local MiniLM (384 dims): non-dup <0.56, dup >0.74
// The optional daemon serves a DIFFERENT bi-encoder (Nemotron, 2048 dims) with its own
// cosine scale — threshold tuned in production (2026-07-17: true dup 0.802, near-miss 0.789).
const DEDUP_THRESHOLD_EMBEDDING_DAEMON = 0.80;

function dedupThresholdForEngine(engine) {
  return engine === 'daemon' ? DEDUP_THRESHOLD_EMBEDDING_DAEMON : DEDUP_THRESHOLD_EMBEDDING;
}
const DEDUP_WEIGHTS = { jaccard: 0.5, substring: 0.3, domain: 0.2 };
const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

// ── Optional embed daemon (zero-dependency fallback) ────────────────
// If a compatible daemon (MnemoClaw embed daemon, embed_server.py) is
// reachable on EMBED_PORT, embeddings are served by the daemon (pre-loaded
// model, batched) and search gains a cross-encoder re-ranking stage. No
// daemon → local MiniLM below, silently. The daemon serves a DIFFERENT
// bi-encoder (Nemotron, 2048 dims) than local (MiniLM, 384 dims) — vectors
// are never mixed: the sqlite cache is tagged per engine and dedup uses an
// engine-specific threshold.
const EMBED_DAEMON_PORT = parseInt(process.env.EMBED_PORT || '8091', 10);
const CROSS_ENCODER_TOP = 20;       // top candidates sent to the cross-encoder
const CROSS_ENCODER_ALPHA = 0.7;    // weight: cross-encoder score vs bi-encoder score

const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'between',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither',
  'this', 'that', 'these', 'those', 'it', 'its', 'use', 'using', 'used']);

// ── Helpers ─────────────────────────────────────────────

function today() { return new Date().toISOString().slice(0, 10); }

function daysDiff(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function writeJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

function ensureLockFile() {
  if (!fs.existsSync(LOCK_FILE)) fs.writeFileSync(LOCK_FILE, '', 'utf8');
}

function getMigrationState() {
  let state = readJSON(MIGRATION_FILE);
  if (!state) {
    state = { version: '5.1.0', phase: 1, started: today(), sessions_in_phase: 0,
              sessions_required: 10, parity_passed: 0, last_parity: null,
              frozen: false, frozen_since: null, total_frozen_days: 0 };
    writeJSON(MIGRATION_FILE, state);
  }
  // Ensure freeze fields exist (migration from older state files)
  if (state.frozen === undefined) {
    state.frozen = false;
    state.frozen_since = null;
    state.total_frozen_days = 0;
    writeJSON(MIGRATION_FILE, state);
  }
  return state;
}

function getFrozenDays() {
  const state = getMigrationState();
  let frozen = state.total_frozen_days || 0;
  // If currently frozen, add days since freeze started
  if (state.frozen && state.frozen_since) {
    frozen += daysDiff(state.frozen_since);
  }
  return frozen;
}

// Adjusted daysDiff that subtracts frozen time
function daysDiffAdjusted(dateStr) {
  return Math.max(0, daysDiff(dateStr) - getFrozenDays());
}

// ── TF-IDF Re-Ranking Engine ───────────────────────────
// Auto-switches: full-scan if < RERANK_THRESHOLD items, FTS4 pre-filter + re-rank if >=

const RERANK_THRESHOLD = 200;       // switch from full-scan to FTS4+rerank
const RERANK_ALPHA = 0.6;           // weight: textual similarity vs heat
const RERANK_MIN_SCORE = 0.08;      // minimum composite score to include
const RERANK_FTS_CANDIDATES = 100;  // max candidates from FTS4 pre-filter

// ── Embed Daemon Client (optional, zero-dependency) ────────────────
// Compatible daemon protocol (MnemoClaw embed-daemon.js):
//   GET  /health          → { ok, models: { biEncoder, crossEncoder } }
//   POST /embed-batch     { texts: [...] }            → { vectors: [[...], ...] }
//   POST /rerank-immune   { query, items, limit }    → { results: [{ index, score, raw, id }] }
// All calls are best-effort: any failure degrades silently to the local engine.

let _daemonState = null; // { ok, biEncoder, crossEncoder, ts }
const DAEMON_OK_TTL = 30000;   // trust a successful /health for 30s
const DAEMON_FAIL_TTL = 60000; // remember a failed probe for 60s

function daemonConfigured() {
  return process.env.IMMUNE_EMBED_DAEMON !== 'off'; // auto (default) | on | off
}

function daemonHttp(method, urlPath, body, timeoutMs) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1', port: EMBED_DAEMON_PORT, path: urlPath, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { reject(new Error('daemon: bad JSON response')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('daemon: timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

async function checkDaemon(force) {
  if (!daemonConfigured()) return { ok: false, biEncoder: false, crossEncoder: false };
  if (!force && _daemonState) {
    const ttl = _daemonState.ok ? DAEMON_OK_TTL : DAEMON_FAIL_TTL;
    if (Date.now() - _daemonState.ts < ttl) return _daemonState;
  }
  try {
    const r = await daemonHttp('GET', '/health', null, 2000);
    _daemonState = {
      ok: !!r.ok,
      biEncoder: !!(r.models && r.models.biEncoder),
      crossEncoder: !!(r.models && r.models.crossEncoder),
      ts: Date.now(),
    };
  } catch {
    _daemonState = { ok: false, biEncoder: false, crossEncoder: false, ts: Date.now() };
  }
  return _daemonState;
}

async function daemonEmbedBatch(texts) {
  const r = await daemonHttp('POST', '/embed-batch', { texts }, 30000);
  if (!r || !Array.isArray(r.vectors) || r.vectors.length !== texts.length || r.vectors.some(v => !Array.isArray(v))) {
    throw new Error('daemon: embed-batch response mismatch');
  }
  return r.vectors;
}

// Note (WDDM / Windows): the first CUDA call after GPU idle can take ~15 s
// to restore the context (GeForce cards are put to sleep by the Windows
// driver). The daemon keeps itself warm (keep-alive thread in
// embed_server.py) so this is rare; when it happens we simply WAIT — the
// result stays Nemotron-quality (no local MiniLM downgrade).
async function daemonRerankImmune(query, items, limit) {
  const r = await daemonHttp('POST', '/rerank-immune', {
    query,
    items: items.map(i => ({ id: i.id, pattern: i.pattern, correction: i.correction, example: i.example })),
    limit,
  }, 30000);
  if (!r || !Array.isArray(r.results)) throw new Error('daemon: rerank-immune response mismatch');
  return r.results;
}

let _dfTable = null;
let _dfCorpusSize = 0;
let _dfDirty = true; // rebuild on first use and after add/update

function buildDFTable(items) {
  const df = {};
  for (const item of items) {
    const terms = tokenize(item.pattern + ' ' + (item.correction || item.example || ''));
    for (const t of terms) df[t] = (df[t] || 0) + 1;
  }
  _dfTable = df;
  _dfCorpusSize = items.length;
  _dfDirty = false;
  return df;
}

function tfidfVector(text, df, N) {
  const terms = tokenize(text);
  const tf = {};
  for (const t of terms) tf[t] = (tf[t] || 0) + 1;
  const vec = {};
  for (const [t, count] of Object.entries(tf)) {
    vec[t] = count * Math.log((N + 1) / ((df[t] || 0) + 1));
  }
  return vec;
}

function cosineSparse(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (const k in a) { normA += a[k] * a[k]; if (k in b) dot += a[k] * b[k]; }
  for (const k in b) normB += b[k] * b[k];
  return (normA && normB) ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

function charTrigrams(text) {
  const s = text.toLowerCase().replace(/[^a-z0-9àâäéèêëïîôùûüÿçœæ]/g, ' ').replace(/\s+/g, ' ').trim();
  const trigrams = new Set();
  for (let i = 0; i <= s.length - 3; i++) trigrams.add(s.substring(i, i + 3));
  return trigrams;
}

function jaccardTrigrams(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) { if (setB.has(t)) inter++; }
  return inter / (setA.size + setB.size - inter);
}

function heatScore(item) {
  const sevWeight = { critical: 1.0, warning: 0.6, info: 0.3 };
  const sev = sevWeight[item.severity] || (item.effectiveness || 0.5); // strategies use effectiveness
  const recency = Math.max(0, 1 - daysDiffAdjusted(item.last_seen || item.first_seen || today()) / 90);
  const frequency = Math.min(1, (item.seen_count || 1) / 5);
  return 0.4 * sev + 0.3 * recency + 0.3 * frequency;
}

async function rerankItems(items, query, domains, limit, type) {
  if (!query || items.length === 0) return items;

  // Normalize: items come raw from the JSON store (no .type field) — the
  // vector cache is keyed by (id, type), so tag them before any lookup.
  items = items.map(it => it.type ? it : { ...it, type: it._searchType || type });

  // Fast path: optional embed daemon (batched bi-encoder + cross-encoder).
  // Same pipeline as the MnemoClaw production daemon (same blending weights,
  // same thresholds, same criticals guarantee). On daemon failure it degrades
  // to the no-model path below (TF-IDF + trigrams) — never to a local MiniLM
  // downgrade when the daemon was the chosen engine.
  const engine = await resolveEmbedEngine();
  if (engine === 'daemon') {
    try {
      const db = await getDB();
      const itemTexts = items.map(i => i.pattern + ' ' + (i.correction || i.example || ''));
      const queryEmb = await embedText(query);
      if (!queryEmb) throw new Error('query embedding failed');
      const vecs = await embedItems(db, items, itemTexts);

      const scored = [];
      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const itemEmb = vecs[idx];
        const textSim = itemEmb ? Math.max(0, cosineSimilarity(queryEmb, itemEmb)) : 0;
        const heat = heatScore(item);
        const composite = RERANK_ALPHA * textSim + (1 - RERANK_ALPHA) * heat;
        scored.push({ ...item, _score: { composite, textSim, heat, engine: 'embedding' } });
      }
      scored.sort((a, b) => b._score.composite - a._score.composite);

      // Stage 3: cross-encoder re-ranking on top candidates
      let finalScored = scored;
      const d = await checkDaemon();
      if (d.crossEncoder && scored.length > 1) {
        const top = scored.slice(0, CROSS_ENCODER_TOP);
        try {
          const ceResults = await daemonRerankImmune(query, top, CROSS_ENCODER_TOP);
          if (ceResults.length > 0) {
            const ceMap = new Map(ceResults.map(r => [r.index, r]));
            const ceScored = top.map((t, i) => {
              const ce = ceMap.get(i);
              if (!ce) return t;
              const composite = CROSS_ENCODER_ALPHA * ce.score + (1 - CROSS_ENCODER_ALPHA) * t._score.composite;
              return { ...t, _score: { ...t._score, composite, ceScore: ce.score, engine: 'cross-encoder' } };
            });
            const ceIds = new Set(ceScored.map(i => i.id));
            finalScored = [...ceScored, ...scored.filter(i => !ceIds.has(i.id))];
            finalScored.sort((a, b) => b._score.composite - a._score.composite);
          }
        } catch (e) {
          process.stderr.write(`[IMMUNE] Cross-encoder unavailable: ${e.message}\n`);
        }
      }
      return finalizeResults(finalScored, limit);
    } catch (e) {
      warnDaemonDead('rerank', e.message);
    }
  }

  // No-model path: TF-IDF + trigrams.
  // In standalone mode ('local') the in-process MiniLM embeddings are the
  // engine for this process and are used as the primary signal. In daemon
  // mode with the daemon down ('none') there is NO local MiniLM downgrade —
  // TF-IDF + trigrams carry the ranking instead.
  const engine2 = await resolveEmbedEngine();
  let queryEmbedding = null;

  if (engine2 === 'local' && _embeddingsAvailable === true) {
    queryEmbedding = await embedText(query);
  }

  // Ensure TF-IDF DF table is built (used as fallback or secondary signal)
  if (_dfDirty || !_dfTable) {
    const allItems = type === 'antibody'
      ? loadAntibodies().antibodies
      : loadStrategies().strategies;
    buildDFTable(allItems);
  }

  const queryVec = tfidfVector(query, _dfTable, _dfCorpusSize);
  const queryTrigrams = charTrigrams(query);

  // Score each candidate
  const db = await getDB();
  const scored = [];
  for (const item of items) {
    const itemText = item.pattern + ' ' + (item.correction || item.example || '');
    let textSim;
    let engine;

    if (queryEmbedding) {
      // Embeddings available: use as primary similarity (sqlite cache,
      // tagged by engine — never mixed across engines)
      const itemEmbedding = await getCachedEmbedding(db, item.id, item.type, itemText);
      if (itemEmbedding) {
        const embSim = cosineSimilarity(queryEmbedding, itemEmbedding);
        // Normalize: MiniLM cosine is typically 0-1, but can be negative
        textSim = Math.max(0, embSim);
        engine = 'embedding';
      } else {
        // Fallback for this item
        const tfidfSim = cosineSparse(queryVec, tfidfVector(itemText, _dfTable, _dfCorpusSize));
        const trigramSim = jaccardTrigrams(queryTrigrams, charTrigrams(itemText));
        textSim = 0.7 * tfidfSim + 0.3 * trigramSim;
        engine = 'tfidf+trigrams';
      }
    } else {
      // No embeddings: TF-IDF + trigrams
      const tfidfSim = cosineSparse(queryVec, tfidfVector(itemText, _dfTable, _dfCorpusSize));
      const trigramSim = jaccardTrigrams(queryTrigrams, charTrigrams(itemText));
      textSim = 0.7 * tfidfSim + 0.3 * trigramSim;
      engine = 'tfidf+trigrams';
    }

    const heat = heatScore(item);
    const composite = RERANK_ALPHA * textSim + (1 - RERANK_ALPHA) * heat;
    scored.push({ ...item, _score: { composite, textSim, heat, engine } });
  }

  // Sort ALL by composite score (criticals and non-criticals alike)
  scored.sort((a, b) => b._score.composite - a._score.composite);

  return finalizeResults(scored, limit);
}

// Shared tail: threshold filter + criticals guarantee + diagnostics.
// Identical to the MnemoClaw production finalizeResults.
function finalizeResults(finalScored, limit) {
  // Apply minimum score threshold on non-criticals only
  const aboveThreshold = finalScored.filter(i =>
    i._score.composite >= RERANK_MIN_SCORE || i.severity === 'critical'
  );

  // Take top results, but guarantee at least the top 3 criticals make it
  const topCriticals = aboveThreshold.filter(i => i.severity === 'critical').slice(0, 3);
  const topCriticalIds = new Set(topCriticals.map(c => c.id));
  const others = aboveThreshold.filter(i => !topCriticalIds.has(i.id)).slice(0, limit - topCriticals.length);
  const result = [...topCriticals, ...others]
    .sort((a, b) => b._score.composite - a._score.composite)
    .slice(0, limit);

  // Diagnostic
  if (result.length > 0 && result[0]._score.composite < 0.1) {
    result._retrieval_warning = `Low relevance: best score ${result[0]._score.composite.toFixed(3)}`;
  }
  result._engine = finalScored.length > 0 ? finalScored[0]._score.engine : 'none';

  return result;
}

// Escape a single FTS4 token by: (1) stripping FTS4 special chars, (2) doubling internal quotes,
// (3) wrapping in double quotes so the result is always treated as a literal phrase.
// Defends against user-controlled patterns leaking wildcards/operators into MATCH syntax.
function ftsEscapeTerm(term) {
  const cleaned = term.replace(/["^()*]/g, ''); // strip FTS4 metacharacters
  if (!cleaned) return null;
  return `"${cleaned.replace(/"/g, '""')}"`;
}

function ftsBuildQuery(query) {
  const terms = [...tokenize(query)].filter(t => t.length >= 2);
  const escaped = terms.map(ftsEscapeTerm).filter(Boolean);
  return escaped.length ? escaped.join(' OR ') : null;
}

async function getFTSCandidates(query, domains, type, limit) {
  const db = await getDB();
  const sourceType = type === 'antibody' ? 'antibody' : 'strategy';

  const ftsQuery = ftsBuildQuery(query);
  if (!ftsQuery) return new Set();

  const sql = `SELECT source_id FROM chunks_fts WHERE chunks_fts MATCH ? AND source_type = ? LIMIT ?`;
  const stmt = db.prepare(sql);
  stmt.bind([ftsQuery, sourceType, limit]);
  const ids = [];
  while (stmt.step()) {
    ids.push(stmt.getAsObject().source_id);
  }
  stmt.free();
  return new Set(ids);
}

// ── Hot/Cold Classification ─────────────────────────────

function isHotAntibody(ab) {
  if (ab.severity === 'critical') return true;
  if (ab.seen_count >= 3) return true;
  if (ab.last_seen && daysDiffAdjusted(ab.last_seen) < 30) return true;
  return false;
}

function isHotStrategy(cs) {
  if (cs.effectiveness >= 0.7) return true;
  if (cs.seen_count >= 3) return true;
  if (cs.last_seen && daysDiffAdjusted(cs.last_seen) < 30) return true;
  return false;
}

function domainMatch(itemDomains, targetDomains) {
  const d = Array.isArray(itemDomains) ? itemDomains : [itemDomains || '_global'];
  return d.some(x => targetDomains.includes(x) || x === '_global');
}

// ── JSON Operations ─────────────────────────────────────

function loadAntibodies() {
  const data = readJSON(JSON_AB);
  if (!data) return { version: 4, antibodies: [], stats: { outputs_checked: 0, issues_caught: 0, antibodies_total: 0 } };
  // v2 migration
  if (data.version === 2) {
    data.antibodies.forEach(ab => { if (ab.domain && !ab.domains) { ab.domains = [ab.domain]; delete ab.domain; } });
    data.version = 3;
    writeJSON(JSON_AB, data);
  }
  return data;
}

function loadStrategies() {
  const data = readJSON(JSON_CS);
  if (!data) return { version: 4, strategies: [], stats: { outputs_assisted: 0, strategies_applied: 0, strategies_total: 0 } };
  return data;
}

// ── SQLite Operations ───────────────────────────────────

let _db = null;

async function getDB() {
  if (_db) return _db;
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    _db = new SQL.Database(buf);
  } else {
    _db = new SQL.Database();
  }
  initSchema(_db);
  return _db;
}

function initSchema(db) {
  db.run(`CREATE TABLE IF NOT EXISTS antibodies (
    id TEXT PRIMARY KEY, domains TEXT NOT NULL, pattern TEXT NOT NULL,
    severity TEXT NOT NULL, correction TEXT NOT NULL,
    seen_count INTEGER DEFAULT 1, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
    quality_gate INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS strategies (
    id TEXT PRIMARY KEY, domains TEXT NOT NULL, pattern TEXT NOT NULL,
    example TEXT, effectiveness REAL DEFAULT 0.5,
    seen_count INTEGER DEFAULT 1, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
    quality_gate INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS session_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, type TEXT NOT NULL,
    domains TEXT, summary TEXT NOT NULL, details TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS stats (key TEXT PRIMARY KEY, value TEXT)`);
  // FTS4
  try {
    db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts4(
      text, source_type, source_id, domains, tokenize=porter
    )`);
  } catch (e) {}
  // Embeddings cache (tagged by engine: local MiniLM 384-dim and daemon
  // Nemotron 2048-dim vectors are NOT interchangeable)
  db.run(`CREATE TABLE IF NOT EXISTS embeddings (
    id TEXT PRIMARY KEY, type TEXT NOT NULL,
    vector BLOB NOT NULL, pattern_hash TEXT NOT NULL,
    model TEXT DEFAULT ''
  )`);
  // Existing DBs: add the model column. Pre-existing rows get '' (unknown) →
  // never reused, rewritten with the correct tag on next cache miss (self-healing).
  try { db.exec(`ALTER TABLE embeddings ADD COLUMN model TEXT DEFAULT ''`); } catch {}
}

function saveDB(db) {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function syncToSQLite(db, antibodies, strategies) {
  // Upsert antibodies
  const stmtAb = db.prepare(`INSERT OR REPLACE INTO antibodies
    (id, domains, pattern, severity, correction, seen_count, first_seen, last_seen, quality_gate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const ab of antibodies) {
    const domains = JSON.stringify(Array.isArray(ab.domains) ? ab.domains : [ab.domains || '_global']);
    stmtAb.run([ab.id, domains, ab.pattern, ab.severity, ab.correction,
                ab.seen_count || 1, ab.first_seen || today(), ab.last_seen || today(), ab.quality_gate || 0]);
  }
  stmtAb.free();

  // Upsert strategies
  const stmtCs = db.prepare(`INSERT OR REPLACE INTO strategies
    (id, domains, pattern, example, effectiveness, seen_count, first_seen, last_seen, quality_gate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const cs of strategies) {
    const domains = JSON.stringify(Array.isArray(cs.domains) ? cs.domains : [cs.domains || '_global']);
    stmtCs.run([cs.id, domains, cs.pattern, cs.example || '', cs.effectiveness || 0.5,
                cs.seen_count || 1, cs.first_seen || today(), cs.last_seen || today(), cs.quality_gate || 0]);
  }
  stmtCs.free();
}

function rebuildFTS(db) {
  db.run(`DELETE FROM chunks_fts`);
  let count = 0;
  const stmt = db.prepare(`INSERT INTO chunks_fts (text, source_type, source_id, domains) VALUES (?, ?, ?, ?)`);
  // Index antibodies
  const abs = db.prepare(`SELECT id, domains, pattern, correction FROM antibodies`);
  while (abs.step()) {
    if (count >= MAX_CHUNKS) break;
    const row = abs.getAsObject();
    stmt.run([`${row.pattern} ${row.correction}`, 'antibody', row.id, row.domains]);
    count++;
  }
  abs.free();
  // Index strategies
  const css = db.prepare(`SELECT id, domains, pattern, example FROM strategies`);
  while (css.step()) {
    if (count >= MAX_CHUNKS) break;
    const row = css.getAsObject();
    stmt.run([`${row.pattern} ${row.example || ''}`, 'strategy', row.id, row.domains]);
    count++;
  }
  css.free();
  stmt.free();
  return count;
}

// ── Commands ────────────────────────────────────────────

async function cmdGetAntibodies(args) {
  // domains absent/vide → AUCUN filtre (retrieval large sur toute la mémoire).
  // Anciennement défaut ['_global'] : rendait invisibles les items taggés avec
  // des domains spécifiques auprès des appelants qui n'en passent pas.
  // (même fix que embed-daemon/embed_server.py — garder les 2 moteurs cohérents)
  const domains = args.domains ? JSON.parse(args.domains) : [];
  const tier = args.tier || 'hot';
  const limit = parseInt(args.limit) || 15;
  const query = args.query || null;

  const data = loadAntibodies();
  let filtered = domains.length
    ? data.antibodies.filter(ab => domainMatch(ab.domains, domains))
    : data.antibodies;

  if (tier === 'hot') {
    filtered = filtered.filter(isHotAntibody);
  } else if (tier === 'cold') {
    filtered = filtered.filter(ab => !isHotAntibody(ab));
  }
  // tier === 'all' → no filter

  // Re-ranking: if --query provided, use TF-IDF + heat composite scoring
  if (query && tier !== 'cold') {
    let candidates = filtered;

    // Auto-switch: FTS4 pre-filter for large corpus, full-scan for small
    if (data.antibodies.length >= RERANK_THRESHOLD) {
      const ftsIds = await getFTSCandidates(query, domains, 'antibody', RERANK_FTS_CANDIDATES);
      // Include all FTS matches + all criticals (guaranteed)
      candidates = filtered.filter(ab => ftsIds.has(ab.id) || ab.severity === 'critical');
    }

    filtered = await rerankItems(candidates, query, domains, limit, 'antibody');
  } else {
    // Original sort (no query)
    if (tier === 'hot') {
      filtered.sort((a, b) => {
        const sev = { critical: 3, warning: 2, info: 1 };
        const sa = sev[a.severity] || 0, sb = sev[b.severity] || 0;
        if (sa !== sb) return sb - sa;
        return (b.seen_count || 0) - (a.seen_count || 0);
      });
      filtered = filtered.slice(0, limit);
    }
  }

  const result = { count: filtered.length, antibodies: filtered };
  if (query && tier !== 'cold') result.reranked = true;
  if (filtered._retrieval_warning) result.retrieval_warning = filtered._retrieval_warning;
  return result;
}

async function cmdGetStrategies(args) {
  // domains absent/vide → AUCUN filtre (voir cmdGetAntibodies)
  const domains = args.domains ? JSON.parse(args.domains) : [];
  const tier = args.tier || 'hot';
  const limit = parseInt(args.limit) || 15;
  const query = args.query || null;

  const data = loadStrategies();
  let filtered = domains.length
    ? data.strategies.filter(cs => domainMatch(cs.domains, domains))
    : data.strategies;

  if (tier === 'hot') {
    filtered = filtered.filter(isHotStrategy);
  } else if (tier === 'cold') {
    filtered = filtered.filter(cs => !isHotStrategy(cs));
  }

  // Re-ranking: if --query provided, use TF-IDF + heat composite scoring
  if (query && tier !== 'cold') {
    let candidates = filtered;

    if (data.strategies.length >= RERANK_THRESHOLD) {
      const ftsIds = await getFTSCandidates(query, domains, 'strategy', RERANK_FTS_CANDIDATES);
      candidates = filtered.filter(cs => ftsIds.has(cs.id));
    }

    filtered = await rerankItems(candidates, query, domains, limit, 'strategy');
  } else {
    if (tier === 'hot') {
      filtered.sort((a, b) => (b.effectiveness || 0) - (a.effectiveness || 0));
      filtered = filtered.slice(0, limit);
    }
  }

  const result = { count: filtered.length, strategies: filtered };
  if (query && tier !== 'cold') result.reranked = true;
  if (filtered._retrieval_warning) result.retrieval_warning = filtered._retrieval_warning;
  return result;
}

async function cmdAddAntibody(args) {
  const ab = JSON.parse(args.json);
  if (!ab.id || !ab.pattern || !ab.severity || !ab.correction) {
    return { error: 'Missing required fields: id, pattern, severity, correction' };
  }
  if (!ab.domains) ab.domains = ['_global'];
  if (!ab.seen_count) ab.seen_count = 1;
  if (!ab.first_seen) ab.first_seen = today();
  if (!ab.last_seen) ab.last_seen = today();

  // Write to JSON
  const data = loadAntibodies();
  const idx = data.antibodies.findIndex(x => x.id === ab.id);
  if (idx >= 0) data.antibodies[idx] = ab;
  else data.antibodies.push(ab);
  data.stats.antibodies_total = data.antibodies.length;
  writeJSON(JSON_AB, data);

  // Write to SQLite (dual-write)
  const db = await getDB();
  syncToSQLite(db, [ab], []);
  saveDB(db);

  _dfDirty = true; // invalidate TF-IDF cache
  return { ok: true, id: ab.id, total: data.antibodies.length };
}

async function cmdAddStrategy(args) {
  const cs = JSON.parse(args.json);
  if (!cs.id || !cs.pattern) {
    return { error: 'Missing required fields: id, pattern' };
  }
  if (!cs.domains) cs.domains = ['_global'];
  if (!cs.effectiveness) cs.effectiveness = 0.5;
  if (!cs.seen_count) cs.seen_count = 1;
  if (!cs.first_seen) cs.first_seen = today();
  if (!cs.last_seen) cs.last_seen = today();

  const data = loadStrategies();
  const idx = data.strategies.findIndex(x => x.id === cs.id);
  if (idx >= 0) data.strategies[idx] = cs;
  else data.strategies.push(cs);
  data.stats.strategies_total = data.strategies.length;
  writeJSON(JSON_CS, data);

  const db = await getDB();
  syncToSQLite(db, [], [cs]);
  saveDB(db);

  _dfDirty = true; // invalidate TF-IDF cache
  return { ok: true, id: cs.id, total: data.strategies.length };
}

async function cmdImport(args) {
  if (!args.file) return { error: 'Usage: import --file <path.immune.json>' };
  const fs = require('fs');
  const content = fs.readFileSync(args.file, 'utf-8');
  const pack = JSON.parse(content);

  let abCount = 0, csCount = 0;

  if (pack.antibodies && Array.isArray(pack.antibodies)) {
    const abData = loadAntibodies();
    for (const ab of pack.antibodies) {
      if (!ab.id || !ab.pattern) continue;
      if (!ab.domains) ab.domains = ['_global'];
      if (!ab.seen_count) ab.seen_count = 1;
      if (!ab.first_seen) ab.first_seen = today();
      if (!ab.last_seen) ab.last_seen = today();
      const idx = abData.antibodies.findIndex(x => x.id === ab.id);
      if (idx >= 0) abData.antibodies[idx] = ab;
      else abData.antibodies.push(ab);
      abCount++;
    }
    abData.stats.antibodies_total = abData.antibodies.length;
    writeJSON(JSON_AB, abData);
    const db = await getDB();
    syncToSQLite(db, pack.antibodies, []);
    saveDB(db);
  }

  if (pack.strategies && Array.isArray(pack.strategies)) {
    const csData = loadStrategies();
    for (const cs of pack.strategies) {
      if (!cs.id || !cs.pattern) continue;
      if (!cs.domains) cs.domains = ['_global'];
      if (!cs.effectiveness) cs.effectiveness = 0.5;
      if (!cs.seen_count) cs.seen_count = 1;
      if (!cs.first_seen) cs.first_seen = today();
      if (!cs.last_seen) cs.last_seen = today();
      const idx = csData.strategies.findIndex(x => x.id === cs.id);
      if (idx >= 0) csData.strategies[idx] = cs;
      else csData.strategies.push(cs);
      csCount++;
    }
    csData.stats.strategies_total = csData.strategies.length;
    writeJSON(JSON_CS, csData);
    const db = await getDB();
    syncToSQLite(db, [], pack.strategies);
    saveDB(db);
  }

  return { ok: true, imported: { antibodies: abCount, strategies: csCount } };
}

async function cmdUpdateAntibody(args) {
  const data = loadAntibodies();
  const ab = data.antibodies.find(x => x.id === args.id);
  if (!ab) return { error: `Antibody ${args.id} not found` };

  if (args.seen_count) ab.seen_count = parseInt(args.seen_count);
  if (args.last_seen) ab.last_seen = args.last_seen;
  if (args.increment_seen) ab.seen_count = (ab.seen_count || 0) + 1;
  writeJSON(JSON_AB, data);

  const db = await getDB();
  syncToSQLite(db, [ab], []);
  saveDB(db);

  return { ok: true, id: ab.id, seen_count: ab.seen_count, last_seen: ab.last_seen };
}

async function cmdUpdateStrategy(args) {
  const data = loadStrategies();
  const cs = data.strategies.find(x => x.id === args.id);
  if (!cs) return { error: `Strategy ${args.id} not found` };

  if (args.seen_count) cs.seen_count = parseInt(args.seen_count);
  if (args.last_seen) cs.last_seen = args.last_seen;
  if (args.effectiveness) cs.effectiveness = parseFloat(args.effectiveness);
  if (args.increment_seen) cs.seen_count = (cs.seen_count || 0) + 1;
  writeJSON(JSON_CS, data);

  const db = await getDB();
  syncToSQLite(db, [], [cs]);
  saveDB(db);

  return { ok: true, id: cs.id, seen_count: cs.seen_count, effectiveness: cs.effectiveness };
}

// ── Reciprocal Rank Fusion (RRF) ─────────────────────────
// Merges ranked lists from multiple retrievers using ranks, not raw scores.
// RRF(doc) = Σ 1/(k + rank(doc))  where k=60 (Cormack et al. SIGIR 2009)

const RRF_K = 60;

function reciprocalRankFusion(rankedLists) {
  // rankedLists: array of arrays, each is [{id, data, score?}, ...] ordered by relevance
  const scores = new Map(); // id -> { rrfScore, data }

  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const key = item.id;
      const contribution = 1.0 / (RRF_K + rank + 1); // rank is 0-indexed, formula uses 1-indexed
      if (!scores.has(key)) {
        scores.set(key, { rrfScore: 0, data: item.data, engines: [] });
      }
      const entry = scores.get(key);
      entry.rrfScore += contribution;
      entry.engines.push(item.engine || 'unknown');
    }
  }

  // Sort by fused score descending
  return [...scores.entries()]
    .map(([id, val]) => ({ id, ...val }))
    .sort((a, b) => b.rrfScore - a.rrfScore);
}

// ── Search: embedding + keyword via RRF ──────────────────

async function fts4Search(query, type, limit) {
  const db = await getDB();
  const countRes = db.exec(`SELECT count(*) FROM chunks_fts`);
  if (!countRes.length || countRes[0].values[0][0] === 0) {
    const abData = loadAntibodies();
    const csData = loadStrategies();
    syncToSQLite(db, abData.antibodies, csData.strategies);
    rebuildFTS(db);
    saveDB(db);
  }

  // Quote each token to neutralize FTS4 special syntax (* " ( ) : AND OR NOT NEAR ^)
  const safeQuery = ftsBuildQuery(query);
  if (!safeQuery) return [];

  let sql = `SELECT source_type, source_id, snippet(chunks_fts, '>>>', '<<<', '...') as snippet
             FROM chunks_fts WHERE chunks_fts MATCH ?`;
  const params = [safeQuery];

  if (type !== 'all') {
    sql += ` AND source_type = ?`;
    params.push(type === 'antibodies' ? 'antibody' : type === 'strategies' ? 'strategy' : type);
  }
  sql += ` LIMIT ?`;
  params.push(limit);

  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    results.push({
      id: `${row.source_type}:${row.source_id}`,
      data: { source_type: row.source_type, source_id: row.source_id, snippet: row.snippet },
      engine: 'fts4',
    });
  }
  stmt.free();
  return results;
}

async function embeddingSearch(query, type, limit) {
  // Vector search: daemon fast path (batched + cross-encoder) or local MiniLM.
  const engine = await resolveEmbedEngine();
  if (engine === 'none') return [];

  const searchType = type === 'antibodies' ? 'antibody'
    : type === 'strategies' ? 'strategy'
    : type;

  let items = [];
  if (searchType === 'antibody' || searchType === 'all') {
    const abData = loadAntibodies();
    items.push(...abData.antibodies.map(ab => ({ ...ab, type: 'antibody', _searchType: 'antibody' })));
  }
  if (searchType === 'strategy' || searchType === 'all') {
    const csData = loadStrategies();
    items.push(...csData.strategies.map(cs => ({ ...cs, type: 'strategy', _searchType: 'strategy' })));
  }

  if (items.length === 0) return [];

  const texts = items.map(item => item.pattern + ' ' + (item.correction || item.example || ''));
  const queryEmbedding = await embedText(query);
  if (!queryEmbedding) return [];
  const itemEmbeddings = await embedItems(await getDB(), items, texts);
  if (!itemEmbeddings) return []; // vector stage off — FTS4 carries the search

  const scored = [];
  for (let idx = 0; idx < items.length; idx++) {
    const itemEmbedding = itemEmbeddings[idx];
    if (!itemEmbedding) continue;
    const score = Math.max(0, cosineSimilarity(queryEmbedding, itemEmbedding));
    scored.push({ item: items[idx], _idx: idx, score });
  }
  scored.sort((a, b) => b.score - a.score);

  // Stage 3: cross-encoder re-ranking on top candidates (daemon only)
  let finalScored = scored;
  let ceApplied = false;
  if (engine === 'daemon' && scored.length > 1) {
    const d = await checkDaemon();
    if (d.crossEncoder) {
      const top = scored.slice(0, CROSS_ENCODER_TOP);
      try {
        const ceResults = await daemonRerankImmune(query, top.map(t => t.item), CROSS_ENCODER_TOP);
        if (ceResults.length > 0) {
          const ceMap = new Map(ceResults.map(r => [r.index, r]));
          finalScored = top
            .map((t, i) => {
              const ce = ceMap.get(i);
              const score = ce ? CROSS_ENCODER_ALPHA * ce.score + (1 - CROSS_ENCODER_ALPHA) * t.score : t.score;
              return { item: t.item, _idx: t._idx, score, ce: !!ce };
            })
            .concat(scored.slice(top.length))
            .sort((a, b) => b.score - a.score);
          ceApplied = true;
        }
      } catch (e) {
        process.stderr.write(`[IMMUNE] Cross-encoder unavailable: ${e.message}\n`);
      }
    }
  }

  return finalScored.slice(0, limit).map(s => ({
    id: `${s.item._searchType}:${s.item.id}`,
    data: {
      source_type: s.item._searchType,
      source_id: s.item.id,
      snippet: texts[s._idx].slice(0, 200),
      score: s.score,
    },
    engine: ceApplied && s.ce ? 'cross-encoder' : 'embedding',
  }));
}

async function cmdSearch(args) {
  const query = args.query;
  const type = args.type || 'all';
  const limit = parseInt(args.limit) || 10;

  // Hybrid: run both engines in parallel, fuse with RRF
  const [embResults, ftsResults] = await Promise.all([
    embeddingSearch(query, type, limit).catch(() => []),
    fts4Search(query, type, limit).catch(() => []),
  ]);

  if (embResults.length === 0 && ftsResults.length === 0) {
    return { count: 0, results: [], engine: 'none' };
  }

  if (embResults.length > 0 && ftsResults.length > 0) {
    const fused = reciprocalRankFusion([embResults, ftsResults]);
    return {
      count: fused.length,
      results: fused.slice(0, limit).map(f => ({
        ...f.data,
        rrf_score: Math.round(f.rrfScore * 10000) / 10000,
        engines: [...new Set(f.engines)],
      })),
      engine: 'rrf',
      engine_detail: { embedding: embResults.length, fts4: ftsResults.length, vector_source: await resolveEmbedEngine() },
    };
  }

  // Single engine available
  const results = embResults.length > 0 ? embResults : ftsResults;
  return {
    count: results.length,
    results: results.slice(0, limit).map(r => r.data),
    engine: embResults.length > 0 ? 'embedding' : 'fts4',
    vector_source: embResults.length > 0 ? await resolveEmbedEngine() : undefined,
  };
}

async function cmdIndex(args) {
  const db = await getDB();
  const abData = loadAntibodies();
  const csData = loadStrategies();
  syncToSQLite(db, abData.antibodies, csData.strategies);
  const count = rebuildFTS(db);
  saveDB(db);
  return { ok: true, chunks_indexed: count, antibodies: abData.antibodies.length,
           strategies: csData.strategies.length };
}

async function cmdStats() {
  const abData = loadAntibodies();
  const csData = loadStrategies();
  const migration = getMigrationState();
  const d = await checkDaemon();
  return {
    antibodies: { total: abData.antibodies.length, ...abData.stats },
    strategies: { total: csData.strategies.length, ...csData.stats },
    embedding: {
      engine: await resolveEmbedEngine(),
      daemon: { port: EMBED_DAEMON_PORT, reachable: d.ok, cross_encoder: d.crossEncoder },
    },
    migration
  };
}

async function cmdDaemonStatus() {
  const d = await checkDaemon(true);
  const active = (d.ok && d.biEncoder) ? 'daemon' : ((await ensureTransformersInstalled()) ? 'local' : 'none');
  return {
    configured: daemonConfigured(),
    port: EMBED_DAEMON_PORT,
    reachable: d.ok,
    models: { biEncoder: d.biEncoder, crossEncoder: d.crossEncoder },
    active_engine: active,
    note: d.ok
      ? 'Daemon in use: batched Nemotron embeddings (2048 dims) + cross-encoder re-ranking. Engine-aware dedup threshold (0.80) and tagged vector cache — never mixed with local vectors.'
      : 'No daemon: local MiniLM in-process (384 dims, dedup threshold 0.70). Zero extra dependencies required; falls back to TF-IDF/Jaccard if the model is unavailable.',
  };
}

async function cmdMigrateStatus() {
  return getMigrationState();
}

async function cmdMigrateAdvance() {
  const state = getMigrationState();
  if (state.phase >= 3) return { ok: false, message: 'Already at phase 3 (final)' };
  state.phase++;
  state.sessions_in_phase = 0;
  state.last_parity = today();
  writeJSON(MIGRATION_FILE, state);
  return { ok: true, phase: state.phase, message: `Advanced to phase ${state.phase}` };
}

async function cmdIntegrityCheck() {
  try {
    const db = await getDB();
    const res = db.exec(`PRAGMA integrity_check`);
    const ok = res.length && res[0].values[0][0] === 'ok';
    return { ok, result: res.length ? res[0].values[0][0] : 'empty' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── ContextMemory Commands ──────────────────────────────

async function cmdLogSession(args) {
  const date = args.date || today();
  const domains = args.domains || '["_global"]';
  const result = args.result || 'clean';
  const summary = args.summary || '';
  const score = args.score ? parseInt(args.score) : null;

  // Write to context/YYYY-MM-DD.md (append)
  if (!fs.existsSync(CONTEXT_DIR)) fs.mkdirSync(CONTEXT_DIR, { recursive: true });
  const logFile = path.join(CONTEXT_DIR, `${date}.md`);
  const timestamp = new Date().toISOString().slice(11, 19);
  const entry = `\n## ${timestamp} | ${result} | domains=${domains}${score !== null ? ` | score=${score}` : ''}\n${summary}\n`;
  fs.appendFileSync(logFile, entry, 'utf8');

  // Write to SQLite session_logs
  const db = await getDB();
  db.run(`INSERT INTO session_logs (date, type, domains, summary, details) VALUES (?, ?, ?, ?, ?)`,
    [date, result, domains, summary, args.details || '']);
  saveDB(db);

  // Index into FTS4
  const sanitized = sanitize(summary);
  const stmt = db.prepare(`INSERT INTO chunks_fts (text, source_type, source_id, domains) VALUES (?, ?, ?, ?)`);
  stmt.run([sanitized, 'session', `session-${date}-${timestamp}`, domains]);
  stmt.free();
  saveDB(db);

  return { ok: true, file: logFile, date, result };
}

async function cmdGetContext(args) {
  const query = args.query;
  const days = parseInt(args.days) || 90;
  const limit = parseInt(args.limit) || 5;

  // FTS4 search on sessions (escape query tokens)
  const db = await getDB();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const safeSessionQuery = ftsBuildQuery(query);
  if (!safeSessionQuery) return { count: 0, results: [], recent_logs: [], engine: 'fts4' };
  let sql = `SELECT source_type, source_id, snippet(chunks_fts, '>>>', '<<<', '...') as snippet
             FROM chunks_fts WHERE chunks_fts MATCH ? AND source_type = 'session' LIMIT ?`;
  const stmt = db.prepare(sql);
  stmt.bind([safeSessionQuery, limit]);
  const results = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    results.push({ source_id: row.source_id, snippet: row.snippet });
  }
  stmt.free();

  const logs = db.prepare(`SELECT date, type, domains, summary FROM session_logs
    WHERE date >= ? ORDER BY date DESC LIMIT ?`);
  logs.bind([cutoff, limit]);
  const recentLogs = [];
  while (logs.step()) {
    recentLogs.push(logs.getAsObject());
  }
  logs.free();

  return { count: results.length, results, recent_logs: recentLogs, engine: 'fts4' };
}

async function cmdIndexContext() {
  const db = await getDB();
  let count = 0;
  const stmt = db.prepare(`INSERT INTO chunks_fts (text, source_type, source_id, domains) VALUES (?, ?, ?, ?)`);

  // Index MEMORY.md if it exists
  if (fs.existsSync(MEMORY_MD)) {
    const content = sanitize(fs.readFileSync(MEMORY_MD, 'utf8'));
    // Chunk into ~400 token blocks (~1600 chars)
    const chunks = chunkText(content, 1600);
    for (const [i, chunk] of chunks.entries()) {
      stmt.run([chunk, 'memory_md', `memory-md-${i}`, '["_global"]']);
      count++;
    }
  }

  // Index USER.md if it exists
  if (fs.existsSync(USER_MD)) {
    const content = sanitize(fs.readFileSync(USER_MD, 'utf8'));
    const chunks = chunkText(content, 1600);
    for (const [i, chunk] of chunks.entries()) {
      stmt.run([chunk, 'user_md', `user-md-${i}`, '["_global"]']);
      count++;
    }
  }

  // Index context/*.md files
  if (fs.existsSync(CONTEXT_DIR)) {
    const files = fs.readdirSync(CONTEXT_DIR).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const content = sanitize(fs.readFileSync(path.join(CONTEXT_DIR, file), 'utf8'));
      const chunks = chunkText(content, 1600);
      for (const [i, chunk] of chunks.entries()) {
        stmt.run([chunk, 'context', `ctx-${file}-${i}`, '["_global"]']);
        count++;
      }
    }
  }
  stmt.free();
  saveDB(db);

  return { ok: true, chunks_indexed: count };
}

function chunkText(text, maxChars) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    // Try to break at newline
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > start + maxChars * 0.5) end = nl + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

async function cmdRetentionCleanup() {
  if (!fs.existsSync(CONTEXT_DIR)) return { ok: true, archived: 0 };
  if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
  const files = fs.readdirSync(CONTEXT_DIR).filter(f => f.endsWith('.md'));
  let archived = 0;

  for (const file of files) {
    const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (dateMatch && dateMatch[1] < cutoff) {
      fs.renameSync(path.join(CONTEXT_DIR, file), path.join(ARCHIVE_DIR, file));
      archived++;
    }
  }

  return { ok: true, archived, cutoff };
}

// ── Score Command ───────────────────────────────────────

async function cmdScore(args) {
  const domains = JSON.parse(args.domains || '["_global"]');
  const corrections = parseInt(args.corrections) || 0;
  const threats = parseInt(args.threats) || 0;
  const severities = args.severities ? JSON.parse(args.severities) : [];
  // severities: array of {severity, count}

  // Base 100, deductions
  let score = 100;
  let deductions = [];
  for (const s of severities) {
    const pts = s.severity === 'critical' ? 20 : s.severity === 'warning' ? 10 : 5;
    const total = pts * (s.count || 1);
    score -= total;
    deductions.push({ severity: s.severity, count: s.count, points: -total });
  }
  score = Math.max(0, score);

  // Domain normalization via Welford's online algorithm
  const db = await getDB();
  const domainKey = domains.sort().join(',');
  const baselineRow = db.exec(`SELECT value FROM stats WHERE key = 'baseline_${domainKey}'`);

  let baseline = { mean: 75, std: 10, n: 0, threshold: 65 };
  if (baselineRow.length && baselineRow[0].values[0][0]) {
    try { baseline = JSON.parse(baselineRow[0].values[0][0]); } catch {}
  }

  // Welford update
  baseline.n++;
  const delta = score - baseline.mean;
  baseline.mean += delta / baseline.n;
  const delta2 = score - baseline.mean;
  if (!baseline._m2) baseline._m2 = 0;
  baseline._m2 += delta * delta2;
  baseline.std = baseline.n > 1 ? Math.sqrt(baseline._m2 / (baseline.n - 1)) : 10;
  baseline.threshold = Math.max(0, baseline.mean - baseline.std);

  // Z-score
  const z = baseline.std > 0 ? (score - baseline.mean) / baseline.std : 0;
  const pass = score >= baseline.threshold;

  // Save updated baseline
  db.run(`INSERT OR REPLACE INTO stats (key, value) VALUES (?, ?)`,
    [`baseline_${domainKey}`, JSON.stringify(baseline)]);
  saveDB(db);

  return {
    score, pass, z: Math.round(z * 100) / 100,
    baseline: { mean: Math.round(baseline.mean * 10) / 10, std: Math.round(baseline.std * 10) / 10,
                threshold: Math.round(baseline.threshold * 10) / 10, n: baseline.n },
    deductions
  };
}

// ── Flush Pre-Compaction ────────────────────────────────

async function cmdFlushPending(args) {
  const pending = JSON.parse(args.json || '{"antibodies":[],"strategies":[]}');
  const flushed = { antibodies: 0, strategies: 0, rejected: [] };

  const db = await getDB();

  // Quality gate for antibodies
  for (const ab of (pending.antibodies || [])) {
    const reject = qualityGate(ab, 'antibody');
    if (reject) { flushed.rejected.push({ id: ab.id, reason: reject }); continue; }

    // Similarity-based duplicate check (embeddings → Jaccard fallback)
    const abDomains = ab.domains || ['_global'];
    const dup = await findBestDuplicate(ab.pattern, abDomains, loadAntibodies().antibodies, 'antibody');
    if (dup) { flushed.rejected.push({ id: ab.id, reason: `duplicate of ${dup.id} (${dup.engine}, score: ${dup.score})` }); continue; }

    ab.quality_gate = 1;
    ab.first_seen = ab.first_seen || today();
    ab.last_seen = ab.last_seen || today();
    ab.seen_count = ab.seen_count || 1;
    if (!ab.domains) ab.domains = ['_global'];

    // Write to JSON
    const data = loadAntibodies();
    const idx = data.antibodies.findIndex(x => x.id === ab.id);
    if (idx >= 0) data.antibodies[idx] = ab;
    else data.antibodies.push(ab);
    data.stats.antibodies_total = data.antibodies.length;
    writeJSON(JSON_AB, data);

    // Write to SQLite
    syncToSQLite(db, [ab], []);
    flushed.antibodies++;
  }

  // Quality gate for strategies
  for (const cs of (pending.strategies || [])) {
    const reject = qualityGate(cs, 'strategy');
    if (reject) { flushed.rejected.push({ id: cs.id, reason: reject }); continue; }

    // Similarity-based duplicate check (embeddings → Jaccard fallback)
    const csDomains = cs.domains || ['_global'];
    const dup = await findBestDuplicate(cs.pattern, csDomains, loadStrategies().strategies, 'strategy');
    if (dup) { flushed.rejected.push({ id: cs.id, reason: `duplicate of ${dup.id} (${dup.engine}, score: ${dup.score})` }); continue; }

    cs.quality_gate = 1;
    cs.first_seen = cs.first_seen || today();
    cs.last_seen = cs.last_seen || today();
    cs.seen_count = cs.seen_count || 1;
    cs.effectiveness = cs.effectiveness || 0.5;
    if (!cs.domains) cs.domains = ['_global'];

    const data = loadStrategies();
    const idx = data.strategies.findIndex(x => x.id === cs.id);
    if (idx >= 0) data.strategies[idx] = cs;
    else data.strategies.push(cs);
    data.stats.strategies_total = data.strategies.length;
    writeJSON(JSON_CS, data);

    syncToSQLite(db, [], [cs]);
    flushed.strategies++;
  }

  // Rebuild FTS after flush
  rebuildFTS(db);
  saveDB(db);

  return { ok: true, flushed, total_ab: loadAntibodies().antibodies.length,
           total_cs: loadStrategies().strategies.length };
}

function qualityGate(item, type) {
  if (!item.id) return 'missing id';
  if (!item.pattern || item.pattern.length < 20) return 'pattern too short (min 20 chars)';
  if (type === 'antibody') {
    if (!item.severity) return 'missing severity';
    if (!item.correction) return 'missing correction';
  }
  return null;
}

// ── Embeddings Layer (auto-install, lazy load) ──────────

let _embedder = null;
let _embeddingsAvailable = null; // null = not checked, true/false = result

async function ensureTransformersInstalled() {
  if (_embeddingsAvailable !== null) return _embeddingsAvailable;
  try {
    await import('@xenova/transformers');
    _embeddingsAvailable = true;
    return true;
  } catch {
    try {
      console.error('[IMMUNE] Installing embeddings engine (one-time, ~50MB)...');
      require('child_process').execSync('npm install @xenova/transformers@2.17.2', {
        cwd: IMMUNE_DIR, stdio: 'pipe', timeout: 120000
      });
      _embeddingsAvailable = true;
      console.error('[IMMUNE] Embeddings engine installed.');
      return true;
    } catch {
      console.error('[IMMUNE] Embeddings unavailable, using Jaccard fallback.');
      _embeddingsAvailable = false;
      return false;
    }
  }
}

async function getEmbedder() {
  if (_embedder) return _embedder;
  const ok = await ensureTransformersInstalled();
  if (!ok) return null;
  try {
    const { pipeline } = await import('@xenova/transformers');
    console.error('[IMMUNE] Loading embedding model (first time may download ~22MB)...');
    _embedder = await pipeline('feature-extraction', EMBEDDING_MODEL);
    console.error('[IMMUNE] Embedding model ready.');
    return _embedder;
  } catch (e) {
    console.error(`[IMMUNE] Embedding model failed: ${e.message}. Using Jaccard.`);
    _embeddingsAvailable = false;
    return null;
  }
}

async function embedTextLocal(text) {
  const embedder = await getEmbedder();
  if (!embedder) return null;
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

// ── Engine resolution: daemon fast path → local fallback ──────────
// 'daemon' = compatible embed daemon reachable (pre-loaded model, batched,
//            + cross-encoder re-ranking in search)
// 'local'  = in-process transformers.js (MiniLM)
// 'none'   = no vector engine (FTS4/TF-IDF/Jaccard only)
// A down daemon is re-probed (negative TTL), so a daemon that comes up
// during the process lifetime is picked up without a restart.
let _embedEngine = null;
let _embedEngineLocked = false;
// Once the daemon has been the engine in this process, it was CHOSEN for its
// model quality (Nemotron). A daemon failure must never silently downgrade to
// local MiniLM — the vector stage is disabled instead (FTS/TF-IDF/Jaccard
// still rank), and the daemon is re-probed (health) on the next call.
let _daemonModeChosen = false;
let _daemonDeadWarned = false;

function warnDaemonDead(kind, msg) {
  if (_daemonDeadWarned) return;
  _daemonDeadWarned = true;
  process.stderr.write(`[IMMUNE] Daemon ${kind} failed (${msg}) — vector stage disabled until the daemon is reachable again (no local MiniLM downgrade: the daemon was chosen for quality).\n`);
}

async function resolveEmbedEngine() {
  if (_embedEngineLocked) return _embedEngine;
  const d = await checkDaemon();
  if (d.ok && d.biEncoder) {
    _embedEngine = 'daemon';
    _embedEngineLocked = true;
    _daemonModeChosen = true;
    process.stderr.write(`[IMMUNE] Embed daemon on 127.0.0.1:${EMBED_DAEMON_PORT} (cross-encoder: ${d.crossEncoder ? 'yes' : 'no'})\n`);
    return _embedEngine;
  }
  // Daemon unavailable:
  // - daemon mode (chosen for quality): no downgrade to local MiniLM — the
  //   vector stage is off ('none'); re-probe on the next call so a daemon
  //   that comes back is picked up.
  // - standalone mode (daemon never available here): local MiniLM is THE
  //   engine for this process, not a fallback.
  if (_daemonModeChosen) {
    _embedEngine = 'none';
    return _embedEngine;
  }
  const localOk = await ensureTransformersInstalled();
  _embedEngine = localOk ? 'local' : 'none';
  if (!localOk) _embedEngineLocked = true; // nothing available → don't re-probe
  return _embedEngine;
}

async function embedText(text) {
  const engine = await resolveEmbedEngine();
  if (engine === 'daemon') {
    try {
      // No cold-wake timeout: a slow daemon is still Nemotron (the chosen
      // quality) — waiting is better than downgrading. The daemon keep-alive
      // (embed_server.py) keeps the CUDA context warm in practice.
      const vecs = await daemonEmbedBatch([text]);
      return vecs[0];
    } catch (e) {
      warnDaemonDead('embed', e.message);
      return null;
    }
  }
  if (engine === 'none') return null;
  return embedTextLocal(text);
}

// Returns: array of vectors (one per text) | null when the vector stage is
// unavailable (daemon mode + daemon down → no quality downgrade to local).
async function embedBatch(texts) {
  if (texts.length === 0) return [];
  const engine = await resolveEmbedEngine();
  if (engine === 'daemon') {
    try {
      return await daemonEmbedBatch(texts);
    } catch (e) {
      warnDaemonDead('embed-batch', e.message);
      return null;
    }
  }
  if (engine === 'none') return null;
  const ok = await ensureTransformersInstalled();
  if (!ok) return texts.map(() => null);
  const out = [];
  for (const t of texts) out.push(await embedTextLocal(t));
  return out;
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function patternHash(text) {
  // Simple hash for cache invalidation
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function modelTagForEngine() {
  // Rows are tagged by engine: a vector computed by one engine (local MiniLM
  // 384-dim vs daemon Nemotron 2048-dim) must never be compared against a
  // query embedded by the other.
  return _embedEngine === 'daemon' ? 'daemon' : 'local';
}

function readCachedEmbedding(db, id, type, pattern) {
  const hash = patternHash(pattern);
  const stmt = db.prepare('SELECT vector, pattern_hash, model FROM embeddings WHERE id = ? AND type = ?');
  stmt.bind([id, type]);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  if (row && row.pattern_hash === hash && (row.model || '') === modelTagForEngine()) {
    return Array.from(new Float32Array(new Uint8Array(row.vector).buffer));
  }
  return null;
}

function storeCachedEmbedding(db, id, type, pattern, vec) {
  if (!vec) return;
  const blob = Buffer.from(new Float32Array(vec).buffer);
  db.run('INSERT OR REPLACE INTO embeddings (id, type, vector, pattern_hash, model) VALUES (?, ?, ?, ?, ?)',
    [id, type, blob, patternHash(pattern), modelTagForEngine()]);
  saveDB(db);
}

async function getCachedEmbedding(db, id, type, pattern) {
  const cached = readCachedEmbedding(db, id, type, pattern);
  if (cached) return cached;
  const vec = await embedText(pattern);
  storeCachedEmbedding(db, id, type, pattern, vec);
  return vec || null;
}

// Embed all item texts, preferring the per-item sqlite cache (tagged by
// engine), batch-fetching whatever is missing in ONE daemon call (or a local
// loop), then persisting the new vectors. Warm cache → zero network.
async function embedItems(db, items, texts) {
  const vectors = new Array(items.length);
  const missing = [];
  for (let i = 0; i < items.length; i++) {
    const v = readCachedEmbedding(db, items[i].id, items[i].type, texts[i]);
    if (v) vectors[i] = v; else missing.push(i);
  }
  if (missing.length) {
    const batch = await embedBatch(missing.map(i => texts[i]));
    if (batch === null) return null; // vector stage off (daemon mode, daemon down)
    missing.forEach((idx, k) => {
      vectors[idx] = batch[k];
      storeCachedEmbedding(db, items[idx].id, items[idx].type, texts[idx], batch[k]);
    });
  }
  return vectors;
}

async function findBestDuplicateEmbeddings(pattern, domains, items, type) {
  // Returns: { id, score, ... } on duplicate | null on clean no-duplicate
  //          | { vectorsFailed: true } when no vector engine could run.
  // (the sqlite vector cache is tagged per engine — daemon Nemotron and
  //  local MiniLM vectors are never compared across engines)
  const db = await getDB();
  const newVec = await embedText(pattern);
  if (!newVec) return { vectorsFailed: true };

  let bestScore = 0;
  let bestItem = null;
  for (const item of items) {
    const cachedVec = await getCachedEmbedding(db, item.id, type, item.pattern);
    if (!cachedVec) continue;
    const score = cosineSimilarity(newVec, cachedVec);
    if (score > bestScore) {
      bestScore = score;
      bestItem = item;
    }
  }
  const threshold = dedupThresholdForEngine(await resolveEmbedEngine());
  if (bestScore >= threshold) {
    return { id: bestItem.id, score: Math.round(bestScore * 1000) / 1000, pattern: bestItem.pattern, engine: 'embedding', threshold };
  }
  return null;
}

// ── Similarity Scoring (Jaccard Fallback) ───────────────

function stem(word) {
  if (word.length > 4 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 3 && word.endsWith('ed') && !word.endsWith('eed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && !word.endsWith('is')) return word.slice(0, -1);
  return word;
}

function tokenize(text) {
  return new Set(
    text.toLowerCase().split(/[\s\-_\/.,;:!?'"()[\]{}]+/)
      .filter(w => w.length >= 2 && !STOPWORDS.has(w))
      .map(stem)
  );
}

function jaccardIndex(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  const inter = [...setA].filter(w => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : inter / union;
}

function longestCommonSubsequence(wordsA, wordsB) {
  // Longest common contiguous word sequence ratio
  if (wordsA.length === 0 || wordsB.length === 0) return 0;
  let maxLen = 0;
  for (let i = 0; i < wordsA.length; i++) {
    for (let j = 0; j < wordsB.length; j++) {
      let len = 0;
      while (i + len < wordsA.length && j + len < wordsB.length
             && wordsA[i + len] === wordsB[j + len]) {
        len++;
      }
      if (len > maxLen) maxLen = len;
    }
  }
  return maxLen / Math.max(wordsA.length, wordsB.length);
}

function similarityScore(patternA, patternB, domainsA, domainsB) {
  const tokA = tokenize(patternA);
  const tokB = tokenize(patternB);
  const wordsA = [...tokA];
  const wordsB = [...tokB];

  const jaccard = jaccardIndex(tokA, tokB);
  const substring = longestCommonSubsequence(wordsA, wordsB);

  const dA = Array.isArray(domainsA) ? domainsA : [domainsA || '_global'];
  const dB = Array.isArray(domainsB) ? domainsB : [domainsB || '_global'];
  const domainBonus = dA.some(d => dB.includes(d) || d === '_global' || dB.includes('_global')) ? 1.0 : 0.0;

  return (jaccard * DEDUP_WEIGHTS.jaccard)
       + (substring * DEDUP_WEIGHTS.substring)
       + (domainBonus * DEDUP_WEIGHTS.domain);
}

function findBestDuplicateJaccard(pattern, domains, items) {
  let bestScore = 0;
  let bestItem = null;
  for (const item of items) {
    const score = similarityScore(pattern, item.pattern, domains, item.domains);
    if (score > bestScore) {
      bestScore = score;
      bestItem = item;
    }
  }
  if (bestScore >= DEDUP_THRESHOLD_JACCARD) {
    return { id: bestItem.id, score: Math.round(bestScore * 1000) / 1000, pattern: bestItem.pattern, engine: 'jaccard' };
  }
  return null;
}

async function findBestDuplicate(pattern, domains, items, type) {
  // Try embeddings first (best quality) — daemon or local
  const engine = await resolveEmbedEngine();
  if (engine !== 'none') {
    const result = await findBestDuplicateEmbeddings(pattern, domains, items, type);
    if (result === null) return null;                    // vectors OK, no duplicate → trust
    if (result && !result.vectorsFailed) return result; // duplicate found
    // vectorsFailed → fall through to Jaccard
  }
  return findBestDuplicateJaccard(pattern, domains, items);
}

// ── Housekeeping ────────────────────────────────────────

async function cmdFreeze() {
  const state = getMigrationState();
  if (state.frozen) return { ok: false, message: `Already frozen since ${state.frozen_since}` };
  state.frozen = true;
  state.frozen_since = today();
  writeJSON(MIGRATION_FILE, state);
  return { ok: true, message: `Frozen. All aging clocks paused. Run 'unfreeze' to resume.`, frozen_since: state.frozen_since };
}

async function cmdUnfreeze() {
  const state = getMigrationState();
  if (!state.frozen) return { ok: false, message: 'Not frozen' };
  const frozenDays = daysDiff(state.frozen_since);
  state.total_frozen_days = (state.total_frozen_days || 0) + frozenDays;
  state.frozen = false;
  state.frozen_since = null;
  writeJSON(MIGRATION_FILE, state);
  return { ok: true, message: `Unfrozen. ${frozenDays} days were frozen (total: ${state.total_frozen_days}d). Clocks resumed.`,
           frozen_days_added: frozenDays, total_frozen_days: state.total_frozen_days };
}

async function cmdHousekeep() {
  // Block housekeep if frozen
  const freezeState = getMigrationState();
  if (freezeState.frozen) {
    return { ok: false, message: `System is frozen since ${freezeState.frozen_since}. Run 'unfreeze' first.` };
  }

  const report = { archived_ab: 0, archived_cs: 0, context_archived: 0, warnings: [] };

  // --- Check limits ---
  const abData = loadAntibodies();
  const csData = loadStrategies();

  // SQLite size check
  if (fs.existsSync(DB_PATH)) {
    const sizeMB = fs.statSync(DB_PATH).size / (1024 * 1024);
    if (sizeMB > LIMITS.max_sqlite_mb) {
      report.warnings.push(`SQLite size ${sizeMB.toFixed(1)}MB exceeds limit ${LIMITS.max_sqlite_mb}MB`);
    }
  }

  // Context files check
  if (fs.existsSync(CONTEXT_DIR)) {
    const ctxFiles = fs.readdirSync(CONTEXT_DIR).filter(f => f.endsWith('.md'));
    if (ctxFiles.length > LIMITS.max_context_files) {
      // Archive oldest beyond limit
      if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
      const sorted = ctxFiles.sort();
      const toArchive = sorted.slice(0, ctxFiles.length - LIMITS.max_context_files);
      for (const f of toArchive) {
        fs.renameSync(path.join(CONTEXT_DIR, f), path.join(ARCHIVE_DIR, f));
        report.context_archived++;
      }
    }
  }

  // --- Archive useless antibodies (COLD + severity!=critical + seen_count<=1 + >180 days old) ---
  if (abData.antibodies.length > LIMITS.max_antibodies) {
    const candidates = abData.antibodies.filter(ab =>
      !isHotAntibody(ab) &&
      ab.severity !== 'critical' &&
      (ab.seen_count || 1) <= 1 &&
      ab.last_seen && daysDiffAdjusted(ab.last_seen) > 180
    );

    // Sort by last_seen ascending (oldest first), archive enough to get under limit
    candidates.sort((a, b) => (a.last_seen || '').localeCompare(b.last_seen || ''));
    const excess = abData.antibodies.length - LIMITS.max_antibodies;
    const toArchive = candidates.slice(0, Math.max(excess, 0));

    if (toArchive.length > 0) {
      // Load or create archive file
      let archive = readJSON(ARCHIVE_AB) || { archived: [], archived_at: [] };
      const archiveIds = new Set(toArchive.map(a => a.id));

      for (const ab of toArchive) {
        archive.archived.push(ab);
        archive.archived_at.push({ id: ab.id, date: today(), reason: 'housekeep: never-useful (COLD, seen<=1, >180d, non-critical)' });
      }
      writeJSON(ARCHIVE_AB, archive);

      // Remove from active list
      abData.antibodies = abData.antibodies.filter(ab => !archiveIds.has(ab.id));
      abData.stats.antibodies_total = abData.antibodies.length;
      writeJSON(JSON_AB, abData);
      report.archived_ab = toArchive.length;
    }

    if (abData.antibodies.length > LIMITS.max_antibodies) {
      report.warnings.push(`Still ${abData.antibodies.length} antibodies after archival (limit: ${LIMITS.max_antibodies}). No more safe candidates.`);
    }
  }

  // --- Archive useless strategies (COLD + seen_count<=1 + effectiveness<0.3 + >180 days old) ---
  if (csData.strategies.length > LIMITS.max_strategies) {
    const candidates = csData.strategies.filter(cs =>
      !isHotStrategy(cs) &&
      (cs.seen_count || 1) <= 1 &&
      (cs.effectiveness || 0.5) < 0.3 &&
      cs.last_seen && daysDiffAdjusted(cs.last_seen) > 180
    );

    candidates.sort((a, b) => (a.last_seen || '').localeCompare(b.last_seen || ''));
    const excess = csData.strategies.length - LIMITS.max_strategies;
    const toArchive = candidates.slice(0, Math.max(excess, 0));

    if (toArchive.length > 0) {
      let archive = readJSON(ARCHIVE_CS) || { archived: [], archived_at: [] };
      const archiveIds = new Set(toArchive.map(s => s.id));

      for (const cs of toArchive) {
        archive.archived.push(cs);
        archive.archived_at.push({ id: cs.id, date: today(), reason: 'housekeep: low-value (COLD, seen<=1, eff<0.3, >180d)' });
      }
      writeJSON(ARCHIVE_CS, archive);

      csData.strategies = csData.strategies.filter(cs => !archiveIds.has(cs.id));
      csData.stats.strategies_total = csData.strategies.length;
      writeJSON(JSON_CS, csData);
      report.archived_cs = toArchive.length;
    }

    if (csData.strategies.length > LIMITS.max_strategies) {
      report.warnings.push(`Still ${csData.strategies.length} strategies after archival (limit: ${LIMITS.max_strategies}). No more safe candidates.`);
    }
  }

  // Rebuild SQLite + FTS after archival
  if (report.archived_ab > 0 || report.archived_cs > 0) {
    const db = await getDB();
    const freshAb = loadAntibodies();
    const freshCs = loadStrategies();
    // Clear and re-sync
    db.run(`DELETE FROM antibodies`);
    db.run(`DELETE FROM strategies`);
    syncToSQLite(db, freshAb.antibodies, freshCs.strategies);
    rebuildFTS(db);
    saveDB(db);
  }

  report.current = {
    antibodies: loadAntibodies().antibodies.length,
    strategies: loadStrategies().strategies.length,
    limits: LIMITS
  };

  return { ok: true, ...report };
}

// ── Check Duplicate Command ─────────────────────────────

async function cmdCheckDuplicate(args) {
  const pattern = args.pattern;
  if (!pattern) return { error: 'Usage: check-duplicate --pattern "..." --domains \'["code"]\' --type antibody' };
  const domains = JSON.parse(args.domains || '["_global"]');
  const type = args.type || 'antibody';

  // Embeddings (daemon or local) + Jaccard
  const engine = await resolveEmbedEngine();
  const items = type === 'antibody' ? loadAntibodies().antibodies : loadStrategies().strategies;
  const match = await findBestDuplicate(pattern, domains, items, type);

  return {
    duplicate: !!(match && !match.vectorsFailed),
    best_match: (match && !match.vectorsFailed) ? match : null,
    engine: match ? match.engine : (engine !== 'none' ? 'embedding' : 'jaccard'),
    thresholds: { embedding: dedupThresholdForEngine(engine), jaccard: DEDUP_THRESHOLD_JACCARD },
    candidates_checked: items.length
  };
}

async function cmdSimilarityTest() {
  const tests = [
    { a: 'Never use --file with wrangler D1', b: 'Avoid wrangler D1 --file flag', dA: ['code'], dB: ['code'], expect: 'dup' },
    { a: 'SQL injection in user login', b: 'SQL injection in payment API', dA: ['code'], dB: ['code'], expect: 'not-dup' },
    { a: 'Always set category_id', b: 'Always set category_id in translations', dA: ['code'], dB: ['code'], expect: 'dup' },
    { a: 'Use info-box for lists', b: 'Use CSS grid for layout', dA: ['webdesign'], dB: ['webdesign'], expect: 'not-dup' },
    { a: 'Never use tables in blog HTML', b: 'Avoid HTML table tags in blog articles', dA: ['code'], dB: ['code'], expect: 'dup' },
    { a: 'Always validate JWT expiry', b: 'Always validate JWT expiry', dA: ['code'], dB: ['domain'], expect: 'dup' },
  ];

  // Test both engines
  const jaccardResults = [];
  for (const t of tests) {
    const score = similarityScore(t.a, t.b, t.dA, t.dB);
    const isDup = score >= DEDUP_THRESHOLD_JACCARD;
    const pass = (t.expect === 'dup' && isDup) || (t.expect === 'not-dup' && !isDup);
    jaccardResults.push({ a: t.a, b: t.b, score: Math.round(score * 1000) / 1000, isDup, expected: t.expect, pass: pass ? 'OK' : 'FAIL' });
  }

  const embeddingResults = [];
  const eThreshold = dedupThresholdForEngine(await resolveEmbedEngine());
  const embedder = await getEmbedder();
  if (embedder) {
    for (const t of tests) {
      const vecA = await embedText(t.a);
      const vecB = await embedText(t.b);
      const score = cosineSimilarity(vecA, vecB);
      const isDup = score >= eThreshold;
      const pass = (t.expect === 'dup' && isDup) || (t.expect === 'not-dup' && !isDup);
      embeddingResults.push({ a: t.a, b: t.b, score: Math.round(score * 1000) / 1000, isDup, expected: t.expect, pass: pass ? 'OK' : 'FAIL' });
    }
  }

  const jPassed = jaccardResults.filter(r => r.pass === 'OK').length;
  const ePassed = embeddingResults.length ? embeddingResults.filter(r => r.pass === 'OK').length : 'N/A';
  const eEngine = await resolveEmbedEngine();

  return {
    jaccard: { tests: tests.length, passed: jPassed, failed: tests.length - jPassed, threshold: DEDUP_THRESHOLD_JACCARD, results: jaccardResults },
    embedding: embeddingResults.length
      ? {
          tests: tests.length, passed: ePassed, failed: tests.length - ePassed,
          threshold: eThreshold, engine: eEngine,
          // Expected values are calibrated for the local MiniLM model. On the
          // daemon (Nemotron) the score distribution differs — use the
          // production-tuned threshold (0.80) and near-miss discrimination.
          note: eEngine === 'daemon' ? 'Running against the daemon engine (Nemotron); suite expectations are MiniLM-calibrated.' : undefined,
          results: embeddingResults,
        }
      : { available: false, reason: 'transformers not installed' }
  };
}

// ── Retrieval Quality Test ─────────────────────────────

async function cmdRetrievalTest() {
  // Test: given a query, verify that expected patterns appear in top results
  // These test semantic matching — queries use different words than the patterns
  const tests = [
    { query: 'network security binding', domains: '["code"]', type: 'antibody',
      expect_contains: 'AB-CODE-0NNN', desc: 'Should find OpenClaw port exposure via semantic match' },
    { query: 'Docker container shell script fails', domains: '["code"]', type: 'antibody',
      expect_contains: 'AB-CODE-0NNN', desc: 'Should find CRLF line ending issue' },
    { query: 'credentials secret management', domains: '["code"]', type: 'antibody',
      expect_contains: 'AB-CODE-0NNN', desc: 'Should find hardcoded credentials pattern' },
    { query: 'protect sensitive service access', domains: '["code"]', type: 'strategy',
      expect_contains: 'CS-CODE-0NN', desc: 'Should find loopback binding strategy' },
    { query: 'monitoring health Docker services', domains: '["code"]', type: 'strategy',
      expect_contains: 'CS-CODE-0NN', desc: 'Should find HTTP healthcheck strategy' },
    { query: 'save money API costs', domains: '["code","strategy"]', type: 'strategy',
      expect_contains: 'CS-STRATEGY-0NN', desc: 'Should find claude-cli backend strategy' },
    { query: 'XSS injection template user data', domains: '["code"]', type: 'antibody',
      expect_contains: 'AB-CODE-0NNN', desc: 'Should find server-side template XSS' },
    { query: 'authentication before expensive operations', domains: '["code"]', type: 'strategy',
      expect_contains: 'CS-CODE-0NN', desc: 'Should find auth-before-API-call strategy' },
  ];

  const results = [];
  for (const t of tests) {
    const domains = JSON.parse(t.domains);
    const allItems = t.type === 'antibody' ? loadAntibodies().antibodies : loadStrategies().strategies;
    const domainFiltered = allItems.filter(i => domainMatch(i.domains, domains));

    // Re-rank
    const ranked = await rerankItems(domainFiltered, t.query, domains, 15, t.type);
    const topIds = ranked.map(i => i.id);
    const found = topIds.includes(t.expect_contains);
    const position = found ? topIds.indexOf(t.expect_contains) + 1 : -1;
    const topScore = ranked.length > 0 ? ranked[0]._score : null;
    const targetScore = ranked.find(i => i.id === t.expect_contains)?._score || null;

    results.push({
      query: t.query, expected: t.expect_contains, desc: t.desc,
      found, position, top_3: topIds.slice(0, 3),
      target_score: targetScore ? targetScore.composite.toFixed(3) : 'N/A',
      pass: found && position <= 10 ? 'OK' : 'FAIL'
    });
  }

  const passed = results.filter(r => r.pass === 'OK').length;
  return {
    tests: tests.length, passed, failed: tests.length - passed,
    engine: 'tfidf+trigrams', alpha: RERANK_ALPHA,
    threshold: RERANK_THRESHOLD, min_score: RERANK_MIN_SCORE,
    results
  };
}

// ── Embed Command (utility for benchmarks/tools) ────────

async function cmdEmbed(args) {
  const text = args.text;
  if (!text) return { error: 'Usage: embed --text "some text"' };
  const vec = await embedText(text);
  if (!vec) return { error: 'Embeddings unavailable', vector: null };
  return { dims: vec.length, engine: await resolveEmbedEngine(), vector: vec };
}

// ── CLI Router ──────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  let command = null;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!command && !arg.startsWith('--')) { command = arg; continue; }
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-/g, '_');
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; }
      else args[key] = true;
    }
  }
  return { command, args };
}

const COMMANDS = {
  'get-antibodies': cmdGetAntibodies,
  'get-strategies': cmdGetStrategies,
  'add-antibody': cmdAddAntibody,
  'add-strategy': cmdAddStrategy,
  'update-antibody': cmdUpdateAntibody,
  'update-strategy': cmdUpdateStrategy,
  'search': cmdSearch,
  'index': cmdIndex,
  'stats': cmdStats,
  'daemon-status': cmdDaemonStatus,
  'embed': cmdEmbed,
  'migrate-status': cmdMigrateStatus,
  'migrate-advance': cmdMigrateAdvance,
  'integrity-check': cmdIntegrityCheck,
  'log-session': cmdLogSession,
  'get-context': cmdGetContext,
  'index-context': cmdIndexContext,
  'retention-cleanup': cmdRetentionCleanup,
  'score': cmdScore,
  'flush-pending': cmdFlushPending,
  'housekeep': cmdHousekeep,
  'freeze': cmdFreeze,
  'unfreeze': cmdUnfreeze,
  'import': cmdImport,
  'check-duplicate': cmdCheckDuplicate,
  'similarity-test': cmdSimilarityTest,
  'retrieval-test': cmdRetrievalTest,
};

async function main() {
  const { command, args } = parseArgs(process.argv);
  if (!command || !COMMANDS[command]) {
    console.error(`Usage: node immune-adapter.js <command> [options]
Commands: ${Object.keys(COMMANDS).join(', ')}`);
    process.exit(1);
  }

  ensureLockFile();
  const needsLock = ['add-antibody', 'add-strategy', 'update-antibody',
                     'update-strategy', 'index', 'migrate-advance',
                     'log-session', 'index-context', 'score', 'flush-pending',
                     'housekeep'].includes(command);
  let result;
  try {
    if (needsLock) {
      const release = await lockfile.lock(LOCK_FILE, {
        retries: { retries: 5, minTimeout: 100, maxTimeout: 1000 },
        stale: 10000
      });
      try { result = await COMMANDS[command](args); }
      finally { await release(); }
    } else {
      result = await COMMANDS[command](args);
    }
    console.log(JSON.stringify(result));
  } catch (e) {
    console.error(JSON.stringify({ error: e.message, stack: e.stack }));
    process.exit(1);
  }
}

main();
