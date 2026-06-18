# Immune Memory Visualizer

Dev tool to render your immune memory as a D3.js HTML dashboard.

## Files

- `immune-viz.js` — Node script that reads all memory sources and produces the HTML
- `immune-viz.html` — Output dashboard (regenerated on each run)
- `immune-v41.png` — Static preview of the dashboard

## Usage

```bash
# From the immune/ root directory (where your memory files live after some use)
cd ~/.claude/skills/immune/
node tools/viz/immune-viz.js
# → writes immune-viz.html, open it in a browser
```

## Required inputs

The script reads from the current working directory:

- `cheatsheet_memory.json` (required)
- `immune_memory.json` (required)
- `analysis.json` (optional)
- `migration_state.json` (optional)
- `context/*.md` (optional)
- `../memory/*.md` (Claude Code memory dir, optional)

If the memory files don't exist yet, run `/immune` once first so the adapter creates them.
