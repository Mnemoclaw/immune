# Immune System v5.0 — Hybrid Adaptive Memory for AI Agents

[![Stars](https://img.shields.io/github/stars/Mnemoclaw/immune?style=social)](https://github.com/Mnemoclaw/immune)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A self-improving memory system that makes AI outputs better over time through two complementary memories:

- **Immune (antibodies)** — Detects and prevents known errors (negative patterns)
- **Cheatsheet (strategies)** — Injects proven best practices before generation (positive patterns)

**v5.0 — Hybrid Search:** Local embeddings (bi-encoder) + FTS4 keyword search, fused via Reciprocal Rank Fusion (RRF). Everything runs in-process via WASM — no server, no daemon, no API keys for search/dedup.

> **Compatibility:** Designed for [Claude Code](https://claude.ai/code) but works with any Anthropic-compatible API endpoint (via `ANTHROPIC_BASE_URL`). Not locked to Anthropic — any provider exposing the Messages API format will work.

## Quick Start

```bash
# 1. Clone
git clone https://github.com/Mnemoclaw/immune.git
cd immune

# 2. Install dependencies (Node.js 18+ required)
npm install

# 3. Copy to Claude Code skills directory
mkdir -p ~/.claude/skills/immune
cp -r * ~/.claude/skills/immune/

# 4. Verify
node ~/.claude/skills/immune/immune-adapter.js stats
```

Then in Claude Code, use `/immune` to scan any output:

```
/immune Check this function for common pitfalls
/immune domain=fitness Vérifie ce programme
/immune domains=fitness,code Check this workout API
```

> **First run:** The embedding model (~22MB) downloads automatically. No API keys needed for search/dedup — everything runs locally via WASM. The immune *scan* uses a fast LLM model (resolved via `ANTHROPIC_DEFAULT_HAIKU_MODEL` env var).

### Automatic Pre-Generation Injection

Inject relevant strategies automatically before every Claude response:

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
            "command": "node /path/to/.claude/skills/immune/immune-inject.js",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

The inject hook detects domains from your prompt via keyword matching and injects up to 5 HOT strategies as compact XML. Zero injection on unrelated prompts. ~50ms overhead.

## Architecture (v5.0)

```
[User Request]
  --> Local embeddings: semantic domain discovery
  --> Hybrid search: embeddings + FTS4 via Reciprocal Rank Fusion
  --> Inject cheatsheet strategies (positive patterns)
  --> Generate output (with strategy context)
  --> Immune scan (detect known + new errors)
  --> Fix errors + learn new antibodies
  --> Local embedding dedup (before adding new patterns)
  --> Score (0-100, domain-normalized)
  --> Session log (for future context recall)
```

## Key Features

### Hybrid Search (v5.0)
1. **Embeddings** (primary) — `Xenova/all-MiniLM-L6-v2` (384 dims, ~22MB, WASM) for semantic matching
2. **FTS4** (secondary) — SQLite full-text search for keyword recall
3. **RRF Fusion** — Reciprocal Rank Fusion merges both engines using ranks, not raw scores
4. **TF-IDF + Trigrams** — Fallback when embeddings unavailable

### Hot/Cold Tiering
Keeps context lean for optimal performance:
- **Hot** — Active patterns: critical severity, seen >= 3 times, or recent (<30 days)
- **Cold** — Dormant patterns: sent as one-line summaries, auto-reactivated on match

### Dual Storage
- **JSON** (`immune_memory.json` / `cheatsheet_memory.json`) — Primary, portable
- **SQLite** (`immune.sqlite`) — FTS4 full-text search + embedding cache

### Deduplication
- Local embedding cosine similarity (threshold: 0.7)
- Jaccard + longest common subsequence fallback (threshold: 0.55)

## File Structure

```
immune/
  immune-adapter.js        # CLI adapter — all operations go through this
  immune-inject.js         # Pre-generation hook (local keyword detection)
  sanitizer.js             # Input sanitization
  config.yaml              # Full configuration
  immune_memory.json       # Antibodies
  cheatsheet_memory.json   # Strategies
  skill.md                 # Claude Code skill definition
  agents/
    immune-scan.md         # Scan agent instructions
  benchmark/
    run-blind.js           # Blind retrieval benchmarks
    run-learning.js        # Learning curve benchmarks
    cases-learning-blind.json
    BENCHMARKS.md          # Benchmark results
```

## CLI Commands

```bash
# Search (hybrid embeddings + FTS4 via RRF)
node immune-adapter.js search --query "docker crash loop" --type antibody
node immune-adapter.js get-context --query "fitness programme" --days 90
node immune-adapter.js check-duplicate --pattern "..." --type antibody

# Retrieval
node immune-adapter.js get-antibodies --domains '["code"]' --tier hot --limit 15
node immune-adapter.js get-strategies --domains '["code"]' --query "security" --limit 10
node immune-adapter.js get-all --query "docker security" --domains '["code"]'

# Add/Update
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
```

## Domains

Patterns are tagged with domains for targeted retrieval:

| Domain | Example Keywords |
|--------|-----------------|
| `code` | function, docker, API, script, deployment |
| `fitness` | muscu, exercice, programme, séance |
| `writing` | article, SEO, blog, rédaction |
| `research` | source, étude, analyse, hypothèse |
| `strategy` | marché, compétiteur, ROI |
| `webdesign` | CSS, HTML, responsive, UI |
| `email` | mails, courriel, inbox, messagerie |
| `calendar` | rdv, planning, agenda, réunion |
| `travel` | voyage, hôtel, billet, itinéraire |
| `_global` | Cross-domain patterns |

## Configuration

All tunable parameters are in `config.yaml`:
- Deduplication thresholds (embedding: 0.7, Jaccard: 0.55)
- Hot/Cold criteria
- Housekeeping limits and archival rules
- Domain keywords for auto-detection

## Dependencies

- `@xenova/transformers` — Local embedding model (auto-installed on first use)
- `sql.js` — SQLite in WASM for FTS4 search
- `proper-lockfile` — Concurrency safety

## License

MIT
