# Immune System v5.0 — Embed-First Adaptive Memory for AI Agents

[![Stars](https://img.shields.io/github/stars/Mnemoclaw/immune?style=social)](https://github.com/Mnemoclaw/immune)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A self-improving memory system that makes AI outputs better over time through two complementary memories:

- **Immune (antibodies)** — Detects and prevents known errors (negative patterns)
- **Cheatsheet (strategies)** — Injects proven best practices before generation (positive patterns)

**v5.0 — Embed-First Architecture:** All search, deduplication, and retrieval now goes through a local embed daemon (bi-encoder + cross-encoder). FTS4 is offline fallback only. This eliminates language-dependent stemming issues and provides true semantic matching across French, English, and any language.

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

Inject relevant strategies automatically before every Claude response via the embed daemon:

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

The inject hook calls the embed daemon's `/suggest-domains` → `/immune-get-all` pipeline. Falls back to local keyword matching when the daemon is offline.

## Architecture (v5.0)

```
[User Request]
  --> Embed daemon: /suggest-domains (semantic domain discovery)
  --> Embed daemon: /immune-get-all (retrieval + 3-stage reranking)
  --> Inject cheatsheet strategies (positive patterns)
  --> Generate output (with strategy context)
  --> Immune scan (detect known + new errors)
  --> Fix errors + learn new antibodies
  --> Embed daemon: /deduplicate (semantic dedup before adding)
  --> Score (0-100, domain-normalized)
  --> Session log (for future context recall)
```

```
[Embed Daemon — port 8091]
  Bi-encoder: Xenova/all-MiniLM-L6-v2 (384 dims, ~22MB)
  Cross-encoder: Xenova/bge-reranker-base

  Endpoints:
    POST /suggest-domains  — Semantic domain discovery from query
    POST /immune-get-all   — Combined AB+CS retrieval + reranking
    POST /search           — Universal semantic search
    POST /deduplicate      — Pattern similarity check
    POST /embed            — Single text embedding
    POST /embed-batch      — Batch embeddings
    POST /rerank           — Generic cross-encoder reranking
    GET  /health           — Health check
```

## Key Features

### Embed-First Search (v5.0)
1. **Embed daemon** (primary) — Bi-encoder embeddings for all search, dedup, context recall
2. **FTS4** (fallback) — SQLite full-text search used only when daemon is offline
3. **Jaccard** (fallback) — Trigram similarity when no embeddings available

The adapter (`immune-adapter.js`) is now an HTTP client to the embed daemon. Search, context, and dedup commands call the daemon first, fall back to local FTS4/Jaccard on failure.

### 3-Stage Retrieval Pipeline
1. **TF-IDF Pre-filter** — Quick scoring to narrow candidates (no model needed)
2. **Bi-encoder Scoring** — `all-MiniLM-L6-v2` computes query/item embeddings, ranks by cosine similarity
3. **Cross-encoder Reranking** — `bge-reranker-base` scores top candidates with query+item pairs

### Hot/Cold Tiering
Keeps context lean for optimal performance:
- **Hot** — Active patterns: critical severity, seen >= 3 times, or recent (<30 days)
- **Cold** — Dormant patterns: sent as one-line summaries, auto-reactivated on match

### Dual Storage
- **JSON** (`immune_memory.json` / `cheatsheet_memory.json`) — Primary, portable
- **SQLite** (`immune.sqlite`) — FTS4 index for offline fallback

### Deduplication
- Embed daemon semantic similarity (threshold: 0.7)
- Local embedding cosine similarity fallback
- Jaccard + longest common subsequence fallback (threshold: 0.55)

## File Structure

```
immune/
  immune-adapter.js        # CLI adapter — HTTP client to embed daemon
  immune-inject.js         # Pre-generation hook (daemon → fallback)
  sanitizer.js             # Input sanitization
  config.yaml              # Full configuration
  immune_memory.json       # Antibodies
  cheatsheet_memory.json   # Strategies
  skill.md                 # Claude Code skill definition
  agents/
    immune-scan.md         # Scan agent instructions
```

## CLI Commands

```bash
# Query (via embed daemon)
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

# Maintenance
node immune-adapter.js stats              # Show counts and migration state
node immune-adapter.js housekeep          # Archive useless patterns
node immune-adapter.js integrity-check    # SQLite integrity check
node immune-adapter.js freeze / unfreeze  # Pause/resume aging clocks
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

Domain discovery is now semantic via the embed daemon — no keyword matching required.

## Configuration

All tunable parameters are in `config.yaml`:
- Embed daemon connection (host, port)
- Deduplication thresholds (embedding: 0.7, Jaccard: 0.55)
- Hot/Cold criteria
- Housekeeping limits and archival rules

## Dependencies

- `@xenova/transformers` — Local embedding model (auto-installed on first use)
- `better-sqlite3` — Native SQLite for FTS4 fallback
- `proper-lockfile` — Concurrency safety

## License

MIT
