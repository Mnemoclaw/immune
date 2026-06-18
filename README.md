# Immune System v5.1.0 — Hybrid Adaptive Memory for AI Agents

[![Stars](https://img.shields.io/github/stars/Mnemoclaw/immune?style=social)](https://github.com/Mnemoclaw/immune)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A self-improving memory system that makes AI outputs better over time through two complementary memories:

- **Immune (antibodies)** — Detects and prevents known errors (negative patterns)
- **Cheatsheet (strategies)** — Injects proven best practices before generation (positive patterns)

**v5.1 — Hybrid Search:** Local embeddings (bi-encoder) + FTS4 keyword search, fused via Reciprocal Rank Fusion (RRF). Everything runs in-process via WASM — no server, no daemon, no API keys for search/dedup.

> **Provider-agnostic:** Built around the Anthropic Messages API shape (originally for [Claude Code](https://claude.ai/code)), but compatible with **any provider** that exposes a Messages-API-compatible endpoint. Set `ANTHROPIC_BASE_URL` to point at your provider (OpenRouter, Mistral, local llama.cpp, Ollama, vLLM, LM Studio, etc.) and `ANTHROPIC_DEFAULT_HAIKU_MODEL` to your provider's fast/cheap model. See **Provider Configuration** below.

---

## Requirements

| Component | Minimum | Notes |
|---|---|---|
| **Node.js** | 18+ | Tested on 20.x and 22.x |
| **Disk** | ~70 MB | Dependencies (~50 MB) + embedding model (~22 MB, downloaded on first use) |
| **RAM** | 256 MB free | Embedding model uses ~150 MB resident |
| **API access** | Any Anthropic-compatible endpoint | Only needed for the *scan* step (LLM). Search/dedup/dedup/strategy injection work fully offline. |

**No GPU required.** Embeddings run on CPU via WASM. The first run downloads the model (~22 MB); subsequent runs use the cache.

**No API key needed for retrieval.** Only the *scan* phase (where an LLM checks your output for known errors) calls a model. Everything else — embedding search, dedup, FTS4 keyword search, strategy injection, scoring, housekeeping — runs locally.

---

## Quick Start

### 1. Install

```bash
git clone https://github.com/Mnemoclaw/immune.git
cd immune
npm install
```

### 2. Copy only the runtime files to your Claude Code skills directory

```bash
mkdir -p ~/.claude/skills/immune
cp immune-adapter.js immune-inject.js sanitizer.js config.yaml skill.md package.json \
   ~/.claude/skills/immune/
cp -r agents benchmark ~/.claude/skills/immune/
cd ~/.claude/skills/immune/
npm install --omit=dev
```

> Avoid `cp -r *` — it copies `node_modules/`, dev artifacts, and lockfiles you don't need.

### 3. Verify

```bash
node ~/.claude/skills/immune/immune-adapter.js stats
```

### 4. Use it

In Claude Code:

```
/immune Check this function for common pitfalls
/immune domain=fitness Vérifie ce programme
/immune domains=fitness,code Check this workout API
```

First invocation will trigger the embedding model download (~22 MB, one-time).

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

**GLM / Mistral / Together / Fireworks / Groq / DeepSeek** — same pattern. The system never hardcodes a vendor.

> Without these variables, the *scan* step will fail. Search, dedup, strategy injection, and scoring all keep working — they don't touch any model.

---

## How It Works

```
[User Request]
  --> Keyword domain detection (no LLM)
  --> Hybrid search: local embeddings + FTS4 via Reciprocal Rank Fusion
  --> Inject cheatsheet strategies (positive patterns) into prompt
  --> Generate output (with strategy context)
  --> Immune scan via cheap LLM (detect known + new errors)
  --> Fix errors + learn new antibodies
  --> Local embedding dedup (before adding new patterns)
  --> Score (0-100, domain-normalized via Welford's algorithm)
  --> Session log (for future context recall)
```

## Key Features

### Hybrid Search (v5.1)
1. **Embeddings** (primary) — `Xenova/all-MiniLM-L6-v2` (384 dims, ~22 MB, WASM) for semantic matching
2. **FTS4** (secondary) — SQLite full-text search for keyword recall
3. **RRF Fusion** — Reciprocal Rank Fusion (k=60, Cormack et al. SIGIR 2009) merges both engines using ranks, not raw scores
4. **TF-IDF + Trigrams** — Fallback when embeddings unavailable

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
# Search (hybrid embeddings + FTS4 via RRF)
node immune-adapter.js search --query "docker crash loop" --type antibody
node immune-adapter.js get-context --query "fitness programme" --days 90
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
node immune-adapter.js stats              # Show counts and migration state
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
| `fitness` | muscu, exercice, programme, séance |
| `writing` | article, SEO, blog, rédaction |
| `research` | source, étude, analyse, hypothèse |
| `strategy` | marché, compétiteur, ROI |
| `webdesign` | CSS, HTML, responsive, UI |
| `travel` | voyage, hôtel, billet, itinéraire |
| `_global` | Cross-domain patterns |

---

## Benchmarks

See [`benchmark/BENCHMARKS.md`](benchmark/BENCHMARKS.md) for the full methodology. Headline results (blind test cases written by independent AI agents that never saw the memory data):

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
