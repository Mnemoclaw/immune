# Immune System v5.3.0 — Hybrid Adaptive Memory for AI Agents

[![Stars](https://img.shields.io/github/stars/Mnemoclaw/immune?style=social)](https://github.com/Mnemoclaw/immune)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A self-improving memory system that makes AI outputs better over time through two complementary memories:

- **Immune (antibodies)** — Detects and prevents known errors (negative patterns)
- **Cheatsheet (strategies)** — Injects proven best practices before generation (positive patterns)

**v5.2 — Hybrid Search:** Local embeddings (bi-encoder) + FTS4 keyword search, fused via Reciprocal Rank Fusion (RRF). Everything runs in-process via WASM — no server, no daemon, no API keys for search/dedup.

> **v5.2.2:** retrieval contract fix — `domains` absent or empty now means **no filtering** (previously defaulted to `_global`, hiding domain-tagged items from callers that pass no domains).

> **Provider-agnostic:** Built around the Anthropic Messages API shape (originally for [Claude Code](https://claude.ai/code)), but compatible with **any provider** that exposes a Messages-API-compatible endpoint. Set `ANTHROPIC_BASE_URL` to point at your provider (OpenRouter, Mistral, local llama.cpp, Ollama, vLLM, LM Studio, etc.) and `ANTHROPIC_DEFAULT_HAIKU_MODEL` to your provider's fast/cheap model. See **Provider Configuration** below.

---

## Requirements

| Component | Minimum | Notes |
|---|---|---|
| **Node.js** | 18+ | Tested on 20.x and 22.x. The installer refuses to run on older versions. |
| **Disk** | ~70 MB | Dependencies (~50 MB) + embedding model (~22 MB, downloaded on first use) |
| **RAM** | 256 MB free | Embedding model uses ~150 MB resident |
| **API access** | Any Anthropic-compatible endpoint | Only needed for the *scan* step (LLM). Search/dedup/dedup/strategy injection work fully offline. |

**No GPU required.** Embeddings run on CPU via WASM. The first run downloads the model (~22 MB); subsequent runs use the cache.

### Retrieval: standalone CPU engine, with an optional GPU daemon

This repo ships **one adapter, two engines, zero mandatory dependencies**.
By default everything runs on CPU (WASM). If a compatible GPU daemon is
reachable on the local network, the adapter uses it automatically — no config
needed, no restart needed, silent fallback if it's gone:

| | Standalone (default) | + GPU daemon (auto-detected) |
|---|---|---|
| Embedding model | `Xenova/all-MiniLM-L6-v2` (384 dims, ~22 MB) | `nvidia/Nemotron-3-Embed-1B` (2048 dims), pre-loaded |
| Reranker | RRF + heat composite | + `BAAI/bge-reranker-v2-m3` cross-encoder on top candidates |
| Hardware | CPU / WASM, no GPU, ~150 MB RAM | CUDA GPU (the MnemoClaw embed daemon, ~8 GB VRAM) |
| Dedup threshold | 0.70 (MiniLM scale) | 0.80 (Nemotron scale, tuned in production 2026-07-17) |
| Vector cache | sqlite, tagged `local` | sqlite, tagged `daemon` (never mixed with local vectors) |
| Best for | clients "petit frère", mnemo-lite, offline, CI | full MnemoClaw on the dev station |

**How it works:** on first use the adapter probes `GET /health` on
`127.0.0.1:8091` (override with `EMBED_PORT`; disable with
`IMMUNE_EMBED_DAEMON=off`). A healthy daemon is trusted for 30 s, a failed
probe is remembered for 60 s — so a daemon that starts/stops during the
process lifetime is picked up automatically.

**The daemon is chosen for quality, so it is never silently downgraded.**
Local MiniLM is the engine only in standalone mode (no daemon on that host) —
that is a normal mode, not a fallback. Once a process has used the daemon:

- a **slow** daemon is waited for (a cold Windows/WDDM GPU can take ~15 s to
  restore its context; the daemon keep-alive normally prevents this),
- a **failed** daemon disables the vector stage for that run — search falls
  back to FTS4 + TF-IDF/trigrams and dedup to Jaccard, with one explicit
  warning on stderr. Results are never silently recomputed with a weaker
  model, so a Nemotron deployment never degrades to MiniLM behind your back.

**Compatible daemon:** the MnemoClaw `embed-daemon` (`embed_server.py` or a Node
`embed-daemon.js` counterpart in a MnemoClaw stack). Protocol: `GET /health`,
`POST /embed-batch` (with `role: 'query' | 'document'` — the bi-encoder is
asymmetric), `POST /rerank-immune`. Both daemon flavors serve the same
protocol; whichever is running wins.

**Dedup + cache are engine-aware:** each engine has its own cosine threshold
(0.70 MiniLM / 0.75 Nemotron — the daemon's 2048-dim document space needs its
own tuning). On the daemon the cosine only *proposes* the 8 closest candidates:
because the "same rule" and "different rule" cosine clusters overlap, the
cross-encoder decides (CE >= 0.45), which removed every false positive in our
measurements. Cache rows are tagged with the engine that produced them, so a
384-dim
vector is never compared against a 2048-dim one: a row is reused only if its
engine tag matches the active engine. There is one row per item id, so switching
engines (standalone ↔ daemon) re-embeds the items instead of mixing scales — that
also means the cache self-heals from rows written before the tag existed.

Both engines read/write the same `immune_memory.json` / `cheatsheet_memory.json`
and follow the same retrieval contract (domains absent → no filtering, tier
hot/all/cold, RRF fusion, heat boost). One codebase, no fork — keep it that way.

> ⚠️ **Nemotron is optional, never required.** Clients who install the npm
> package get the standalone CPU engine and never download a GPU model. The
> daemon is a pure acceleration/quality layer for full MnemoClaw deployments.

**No API key needed for retrieval.** Only the *scan* phase (where an LLM checks your output for known errors) calls a model. Everything else — embedding search, dedup, FTS4 keyword search, strategy injection, scoring, housekeeping — runs locally.

---

## Quick Start

### 1. Install

```bash
npm install -g @mnemoclaw/immune
immune init
```

That's it — `immune init` copies the skill into `~/.claude/skills/immune/`, installs dependencies, and verifies the install.

### Upgrading

```bash
npm update -g @mnemoclaw/immune && immune
```

**Both steps are required.** `npm update` refreshes the npm package, but the code your agent actually runs is a *copy* of the adapter inside `~/.claude/skills/immune/` — only `immune init` refreshes that copy. Running `npm update` alone changes nothing at runtime, which is the classic "I updated and nothing happened".

The CLI checks npm once a day (cached in `~/.claude/skills/immune/.update-check.json`, no telemetry, silent when offline) and prints a single-line notice when a newer version exists. `immune version` shows both versions so any drift is visible:

```
@mnemoclaw/immune v5.3.1 (npm package)
Skill dir: ~/.claude/skills/immune -> v5.2.1 (different from the package)
  to apply v5.3.1: immune init
```

`node immune-adapter.js version` (or the `version` field of `stats`) reports the version of the code actually executing.

> No npm? Use [Manual install](#manual-install-alternative) below.

### 2. Use it

In Claude Code:

```
/immune Check this function for common pitfalls
/immune domain=domain Vérifie ce programme
/immune domains=domain,code Check this workout API
```

First invocation will trigger the embedding model download (~22 MB, one-time).

### Manual install (alternative)

If you prefer git clone over npm, or want to hack on the source:

```bash
git clone https://github.com/Mnemoclaw/immune.git
cd immune
npm install
```

Then copy only the runtime files into your Claude Code skills directory:

```bash
mkdir -p ~/.claude/skills/immune
cp immune-adapter.js immune-inject.js sanitizer.js config.yaml skill.md package.json \
   ~/.claude/skills/immune/
cp -r agents ~/.claude/skills/immune/
cd ~/.claude/skills/immune/
npm install --omit=dev
node immune-adapter.js stats
```

> Prefer a filtered copy over `cp -r *` — `cp -r *` copies `node_modules/`, dev artifacts, and lockfiles alongside the files you actually need.

---

## Provider Configuration

The immune *scan* (LLM-based detection) needs a model. The "haiku" alias in the code is a logical name — Claude Code resolves it through environment variables. **Any provider works** as long as it speaks the Messages API shape.

### Examples

**Anthropic (default):**
```bash
export ANTHROPIC_API_KEY=sk-ant-...
# haiku alias already points to claude-haiku on first-party
```

**OpenRouter:**
```bash
export ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1
export ANTHROPIC_API_KEY=sk-or-...
export ANTHROPIC_DEFAULT_HAIKU_MODEL=mistralai/ministral-8b    # cheap fast tier
export ANTHROPIC_DEFAULT_SONNET_MODEL=anthropic/claude-sonnet  # balanced tier
```

**Local (Ollama, llama.cpp, LM Studio, vLLM):**
```bash
export ANTHROPIC_BASE_URL=http://localhost:11434/v1   # Ollama example
export ANTHROPIC_API_KEY=local                        # any non-empty string
export ANTHROPIC_DEFAULT_HAIKU_MODEL=qwen2.5:7b
export ANTHROPIC_DEFAULT_SONNET_MODEL=qwen2.5:14b
```

**GLM / Mistral / Together / Fireworks / Groq / DeepSeek** — same pattern. The system keeps every vendor configurable.

> Without these variables, the *scan* step will fail. Search, dedup, strategy injection, and scoring all keep working — they operate independently of any model.

---

## How It Works

```
[User Request]
  --> Keyword domain detection (no LLM)
  --> Hybrid search: vector engine (GPU daemon if reachable, else local
      embeddings) + FTS4 via Reciprocal Rank Fusion,
      + cross-encoder re-ranking on top candidates (daemon only)
  --> Inject cheatsheet strategies (positive patterns) into prompt
  --> Generate output (with strategy context)
  --> Immune scan via cheap LLM (detect known + new errors)
  --> Fix errors + learn new antibodies
  --> Local embedding dedup (before adding new patterns)
  --> Score (0-100, domain-normalized via Welford's algorithm)
  --> Session log (for future context recall)
```

## Key Features

### Hybrid Search (v5.3)
1. **Vector engine** (primary) — local `Xenova/all-MiniLM-L6-v2` (384 dims, ~22 MB, WASM) by default; automatically switches to an optional GPU daemon (Nemotron 2048 dims, batched) when one is reachable on `EMBED_PORT`
2. **FTS4** (secondary) — SQLite full-text search for keyword recall
3. **RRF Fusion** — Reciprocal Rank Fusion (k=60, Cormack et al. SIGIR 2009) merges both engines using ranks, not raw scores
4. **Cross-encoder** (optional, daemon only) — `BAAI/bge-reranker-v2-m3` re-ranks the top 20 candidates (0.7 × ce + 0.3 × bi-encoder, same blend as the production pipeline)
5. **TF-IDF + Trigrams** — Fallback when no vector engine is available

### Hot/Cold Tiering
Keeps context lean for optimal performance:
- **Hot** — Active patterns: critical severity, seen ≥ 3 times, or recent (<30 days)
- **Cold** — Dormant patterns: sent as one-line summaries, auto-reactivated on match

### Dual Storage
- **JSON** (`immune_memory.json` / `cheatsheet_memory.json`) — Primary, portable, human-readable
- **SQLite** (`immune.sqlite`) — FTS4 full-text search + embedding cache

### Deduplication
- Local embedding cosine similarity (threshold: 0.7)
- Jaccard + longest common subsequence fallback (threshold: 0.55)

### Quality Gates
- `housekeep` only archives patterns that are COLD + low-seen + old + non-critical
- `flush-pending` runs `check-duplicate` before any write — duplicates reactivate the original instead of creating new entries
- `freeze` / `unfreeze` pauses aging clocks (e.g. during vacations) without losing history

---

## Automatic Pre-Generation Injection

Inject relevant strategies into every Claude response automatically:

```bash
# Test the inject script manually
echo '{"prompt":"Write a Node.js API endpoint"}' | node ~/.claude/skills/immune/immune-inject.js
```

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/.claude/skills/immune/immune-inject.js",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

The inject hook detects domains from your prompt via keyword matching and injects up to 5 HOT strategies as compact XML. Zero injection on unrelated prompts. ~50 ms overhead. **No LLM call** — entirely local.

---

## File Structure

```
immune/
  immune-adapter.js        # CLI adapter — all operations go through this
  immune-inject.js         # Pre-generation hook (local keyword detection)
  sanitizer.js             # Input sanitization (strips secrets before storage)
  config.yaml              # Full configuration
  skill.md                 # Claude Code skill definition
  agents/
    immune-scan.md         # Scan agent instructions
  benchmark/
    run-blind.js           # Blind retrieval + generalization + learning benchmarks
    run-learning.js        # Standalone learning curve benchmark
    sample-queries.json    # Example benchmark queries (20 cases)
    cases-learning-blind.json
    BENCHMARKS.md          # Published benchmark results
  tools/viz/               # Optional D3 dashboard for inspecting your memory
    README.md
    immune-viz.js          # Generates immune-viz.html from memory files
```

Files generated at runtime (gitignored): `immune_memory.json`, `cheatsheet_memory.json`, `immune.sqlite`, `migration_state.json`, `archived_*.json`, `context/`.

---

## CLI Commands

```bash
# Search (vector engine + FTS4 via RRF; cross-encoder when a daemon is up)
node immune-adapter.js search --query "docker crash loop" --type antibody
node immune-adapter.js get-context --query "domain programme" --days 90
node immune-adapter.js check-duplicate --pattern "..." --type antibody

# Retrieval
node immune-adapter.js get-antibodies --domains '["code"]' --tier hot --limit 15
node immune-adapter.js get-strategies --domains '["code"]' --query "security" --limit 10

# Add / Update
node immune-adapter.js add-antibody --json '{"id":"AB-001","pattern":"...","severity":"critical","correction":"..."}'
node immune-adapter.js update-antibody --id AB-001 --increment_seen

# Bulk
node immune-adapter.js flush-pending --json '{"antibodies":[...],"strategies":[...]}'
node immune-adapter.js import --file export.immune.json

# Maintenance
node immune-adapter.js index              # Rebuild FTS4 index
node immune-adapter.js stats              # Show counts, migration state + active vector engine
node immune-adapter.js daemon-status      # Probe the optional GPU daemon (health, models, active engine)
node immune-adapter.js housekeep          # Archive useless patterns
node immune-adapter.js integrity-check    # SQLite integrity check
node immune-adapter.js freeze / unfreeze  # Pause/resume aging clocks

# Testing
node immune-adapter.js similarity-test    # Run dedup test suite
node immune-adapter.js retrieval-test     # Run semantic retrieval tests
node immune-adapter.js embed --text "..." # Get raw embedding vector
```

---

## Domains

Patterns are tagged with domains for targeted retrieval. Edit `config.yaml:domain_keywords` to add your own.

| Domain | Example Keywords |
|--------|-----------------|
| `code` | function, docker, API, script, deployment |
| `domain` | muscu, exercice, programme, séance |
| `writing` | article, SEO, blog, rédaction |
| `research` | source, étude, analyse, hypothèse |
| `strategy` | marché, compétiteur, ROI |
| `webdesign` | CSS, HTML, responsive, UI |
| `travel` | voyage, hôtel, billet, itinéraire |
| `_global` | Cross-domain patterns |

---

## Benchmarks

See [`benchmark/BENCHMARKS.md`](benchmark/BENCHMARKS.md) for the full methodology. Headline results (blind test cases written by independent AI agents kept fully blind to the memory data):

| Benchmark | Score |
|---|---|
| Retrieval accuracy | **70 %** (14/20) |
| Cross-domain generalization | **53 %** (4 strong + 8 partial / 15) |
| Improvement after 1 learning pass | **+74 pts** (0 % → 74 %) |
| Housekeep safety | **0 pts lost** |

Reproduce:
```bash
node benchmark/run-blind.js
node benchmark/run-learning.js --cases benchmark/cases-learning-blind.json
```

The retrieval benchmark reads from `benchmark/sample-queries.json` by default. Point `IMMUNE_BENCH_QUERIES` at your own file to evaluate against your own memory.

---

## Configuration

All tunable parameters live in `config.yaml`:
- Deduplication thresholds (embedding: 0.7, Jaccard: 0.55)
- Hot/Cold criteria
- Housekeeping limits and archival rules (`max_antibodies: 500`, `max_strategies: 300`, `max_sqlite_mb: 50`)
- Domain keywords for auto-detection (edit freely to match your content)

---

## Dependencies

- `@xenova/transformers` ^2.17.2 — Local embedding model (auto-cached on first use)
- `sql.js` ^1.14.1 — SQLite in WASM for FTS4 search
- `proper-lockfile` ^4.1.2 — Concurrency safety
- `protobufjs` ^7.5.8 (override) — Forces patched version to silence npm audit warnings

---

## License

MIT — Jacques Chauvin. See [LICENSE](LICENSE).
