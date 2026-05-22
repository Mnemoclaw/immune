# Immune System v4.1 — Hybrid Adaptive Memory for AI Agents

[![Stars](https://img.shields.io/github/stars/Mnemoclaw/immune?style=social)](https://github.com/Mnemoclaw/immune)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A self-improving memory system that makes AI outputs better over time through two complementary memories:

- **Immune (antibodies)** — Detects and prevents known errors (negative patterns)
- **Cheatsheet (strategies)** — Injects proven best practices before generation (positive patterns)

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

> **First run:** The embedding model (~22MB) downloads automatically. No API keys needed — everything runs locally via WASM.

### Automatic Pre-Generation Injection (Optional)

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
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

This detects the domain from your prompt (code, fitness, writing, etc.) and injects up to 5 HOT strategies as compact XML before Claude generates. Zero injection on unrelated prompts. ~50ms overhead.

## Architecture

```
[User Request]
  --> Context search (recall past sessions via FTS4)
  --> Inject cheatsheet strategies (positive patterns)
  --> Generate output (with strategy context)
  --> Immune scan (detect known + new errors)
  --> Fix errors + learn new antibodies
  --> Detect + learn new winning strategies
  --> Score (0-100, domain-normalized)
  --> Session log (for future context recall)
  --> Flush pending patterns (before context compaction)

[Retrieval Pipeline]
  FTS4 pre-filter → Bi-encoder embeddings → Cross-encoder rerank → Top-N results
```

## Key Features

### 3-Stage Retrieval (v4.1)
1. **FTS4 Pre-filter** — SQLite full-text search narrows candidates
2. **Bi-encoder Scoring** — `Xenova/all-MiniLM-L6-v2` (384 dims, ~22MB, WASM) computes query/item embeddings, ranks by cosine similarity
3. **Cross-encoder Reranking** — `Xenova/ms-marco-MiniLM-L-6-v2` scores top candidates with query+item pairs for precision boost (alpha=0.7 blend with bi-encoder scores)
- **TF-IDF Fallback** — Sparse vector similarity when embeddings unavailable
- **Character Trigrams** — Jaccard similarity for fuzzy matching
- **Auto-switch** — Full-scan for small corpus (<200), FTS4 pre-filter for large corpus

### Hot/Cold Tiering
Keeps context lean for optimal performance:
- **Hot** — Active patterns: critical severity, seen >= 3 times, or recent (<30 days)
- **Cold** — Dormant patterns: sent as one-line summaries, auto-reactivated on match

### Dual Storage
- **SQLite** (`immune.sqlite`) — FTS4 full-text search + structured queries
- **JSON** (`immune_memory.json` / `cheatsheet_memory.json`) — Portable fallback

### Deduplication
- Embedding-based cosine similarity (threshold: 0.7)
- Jaccard + longest common subsequence fallback (threshold: 0.55)
- Quality gate: min 20 chars pattern, required fields enforced

### Housekeeping
- Smart archival of useless patterns (COLD + low engagement + >180 days)
- Configurable limits (500 antibodies, 300 strategies, 50MB SQLite)
- Freeze/unfreeze to pause aging during inactive periods

## File Structure

```
immune/
  immune-adapter.js        # CLI adapter — all operations go through this
  sanitizer.js              # Input sanitization
  config.yaml               # Full configuration (thresholds, domains, limits)
  immune_memory.json        # Antibodies (79 entries)
  cheatsheet_memory.json    # Strategies (82 entries)
  migration_state.json      # Migration/phasing state
  analysis.json             # Pattern analysis data
  package.json              # Dependencies
  skill.md                  # Claude Code skill definition
  agents/
    immune-scan.md          # Scan agent instructions
  context/
    2026-03-29.md           # Session logs
    2026-04-01.md
```

## CLI Commands

```bash
# Query
node immune-adapter.js get-antibodies --domains '["code"]' --tier hot --limit 15
node immune-adapter.js get-strategies --domains '["code"]' --query "security" --limit 10
node immune-adapter.js search --query "XSS injection" --type antibodies

# Add/Update
node immune-adapter.js add-antibody --json '{"id":"AB-001","pattern":"...","severity":"critical","correction":"..."}'
node immune-adapter.js update-antibody --id AB-001 --increment_seen

# Bulk
node immune-adapter.js flush-pending --json '{"antibodies":[...],"strategies":[...]}'
node immune-adapter.js import --file export.immune.json
node immune-adapter.js get-all --query "docker security" --domains '["code"]'  # Combined antibodies+strategies

# Conversations
node immune-adapter.js scan-conversations     # Scan session logs for immune analysis
node immune-adapter.js cleanup-conversations  # Prune old conversation archives

# Visualization
node immune-viz.js                            # Generate immune-viz.html dashboard

# Maintenance
node immune-adapter.js index              # Rebuild FTS4 index
node immune-adapter.js stats              # Show counts and migration state
node immune-adapter.js housekeep          # Archive useless patterns
node immune-adapter.js integrity-check    # SQLite integrity check
node immune-adapter.js freeze             # Pause aging clocks
node immune-adapter.js unfreeze           # Resume aging clocks

# Testing
node immune-adapter.js similarity-test    # Run dedup test suite
node immune-adapter.js retrieval-test     # Run semantic retrieval tests
node immune-adapter.js check-duplicate --pattern "..." --type antibody
```

## Domains

Patterns are tagged with domains for targeted retrieval:

| Domain | Keywords |
|--------|----------|
| `code` | function, class, import, SQL, API, worker |
| `fitness` | séries, reps, exercice, squat, programme |
| `writing` | paragraphe, article, SEO, blog |
| `research` | source, étude, analyse, hypothèse |
| `strategy` | marché, compétiteur, ROI, revenue |
| `webdesign` | CSS, HTML, responsive, CTA, UI |
| `travel` | voyage, plage, hôtel, itinéraire, visa |
| `_global` | Cross-domain patterns |

## Configuration

All tunable parameters are in `config.yaml`:
- Cross-encoder alpha (0.7) and top-N candidates (20)
- Bi-encoder deduplication thresholds (embedding: 0.7, Jaccard: 0.55)
- Hot/Cold criteria
- Housekeeping limits and archival rules
- Domain keywords for auto-detection

## Dependencies

- `sql.js` — SQLite in WASM
- `@xenova/transformers` — Local embedding model (auto-installed on first use)
- `proper-lockfile` — Concurrency safety

## License

MIT
