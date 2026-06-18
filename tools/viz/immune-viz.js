#!/usr/bin/env node
// immune-viz.js — Generate immune-viz.html from all memory sources
// Usage: node immune-viz.js

const fs = require('fs');
const path = require('path');

const DIR = __dirname;

// 1. Load all data sources
const cheatsheet = JSON.parse(fs.readFileSync(path.join(DIR, 'cheatsheet_memory.json'), 'utf8'));
const immune = JSON.parse(fs.readFileSync(path.join(DIR, 'immune_memory.json'), 'utf8'));
const analysis = JSON.parse(fs.readFileSync(path.join(DIR, 'analysis.json'), 'utf8'));
const migration = JSON.parse(fs.readFileSync(path.join(DIR, 'migration_state.json'), 'utf8'));

// 2. Load context logs
const contextDir = path.join(DIR, 'context');
const contextLogs = [];
if (fs.existsSync(contextDir)) {
  fs.readdirSync(contextDir).filter(f => f.endsWith('.md')).forEach(f => {
    const content = fs.readFileSync(path.join(contextDir, f), 'utf8');
    contextLogs.push({ file: f, content: content.trim() });
  });
}

// 3. Load Claude memories
const memoryDir = path.join(DIR, '..', 'memory');
const claudeMemories = [];
if (fs.existsSync(memoryDir)) {
  fs.readdirSync(memoryDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md').forEach(f => {
    const content = fs.readFileSync(path.join(memoryDir, f), 'utf8');
    // Parse frontmatter
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    const meta = {};
    if (fmMatch) {
      fmMatch[1].split('\n').forEach(line => {
        const [k, ...v] = line.split(': ');
        if (k && v.length) meta[k] = v.join(': ');
      });
      claudeMemories.push({
        file: f,
        name: meta.name || f,
        type: meta.type || 'unknown',
        description: meta.description || '',
        content: fmMatch[2].trim(),
        size: content.length
      });
    }
  });
}

// 4. Compute stats
const allDates = [
  ...cheatsheet.strategies.map(s => ({ date: s.first_seen, type: 'strategy' })),
  ...immune.antibodies.map(a => ({ date: a.first_seen, type: 'antibody' }))
].sort((a, b) => a.date.localeCompare(b.date));

// Cumulative growth by date
const growthMap = {};
let csCount = 0, abCount = 0;
allDates.forEach(d => {
  if (d.type === 'strategy') csCount++;
  else abCount++;
  growthMap[d.date] = { date: d.date, strategies: csCount, antibodies: abCount, total: csCount + abCount };
});
const growth = Object.values(growthMap).sort((a, b) => a.date.localeCompare(b.date));

// Domain aggregation
const domainStats = {};
const domainColors = {
  code: '#4fc3f7',
  fitness: '#66bb6a',
  webdesign: '#ab47bc',
  writing: '#ffa726',
  travel: '#26c6da',
  strategy: '#ffee58',
  _global: '#bdbdbd',
  research: '#ef5350'
};

function addDomain(stats, domain, type) {
  if (!stats[domain]) stats[domain] = { strategies: 0, antibodies: 0, critical: 0, warning: 0, info: 0, avgEff: 0, effs: [] };
  if (type === 'strategy') stats[domain].strategies++;
  else stats[domain].antibodies++;
}
cheatsheet.strategies.forEach(s => {
  s.domains.forEach(d => {
    addDomain(domainStats, d, 'strategy');
    domainStats[d].effs.push(s.effectiveness);
  });
});
immune.antibodies.forEach(a => {
  a.domains.forEach(d => {
    addDomain(domainStats, d, 'antibody');
    if (domainStats[d][a.severity] !== undefined) domainStats[d][a.severity]++;
  });
});
Object.keys(domainStats).forEach(d => {
  const s = domainStats[d];
  s.avgEff = s.effs.length ? (s.effs.reduce((a, b) => a + b, 0) / s.effs.length) : 0;
  s.total = s.strategies + s.antibodies;
});

// 5. Build nodes for nebula
const nodes = [
  ...cheatsheet.strategies.map(s => ({
    id: s.id, type: 'strategy', domain: s.domains[0], domains: s.domains,
    effectiveness: s.effectiveness, seen: s.seen_count, date: s.first_seen,
    label: s.id, pattern: s.pattern.substring(0, 80)
  })),
  ...immune.antibodies.map(a => ({
    id: a.id, type: 'antibody', domain: a.domains[0], domains: a.domains,
    severity: a.severity, seen: a.seen_count, date: a.first_seen,
    label: a.id, pattern: a.pattern.substring(0, 80)
  }))
];

// 5b. Build links between nodes — three types:
//   type 'domain': share at least one domain (cross-domain connections)
//   type 'corrective': AB↔CS in same domain (antibody correction paired with strategy)
//   type 'semantic': text similarity between patterns (keyword overlap > threshold)

function jaccardText(a, b) {
  const wa = a.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const wb = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (!wa.length || !wb.size) return 0;
  const inter = wa.filter(w => wb.has(w)).length;
  return inter / (wa.length + wb.size - inter);
}

const allLinks = [];

// Strategy nodes with full data for similarity
const strategyFull = cheatsheet.strategies;
const antibodyFull = immune.antibodies;

// 1. Cross-domain links (different primary domain, shared secondary)
for (let i = 0; i < nodes.length; i++) {
  for (let j = i + 1; j < nodes.length; j++) {
    const shared = nodes[i].domains.filter(d => nodes[j].domains.includes(d));
    if (shared.length > 0 && nodes[i].domain !== nodes[j].domain) {
      allLinks.push({ source: nodes[i].id, target: nodes[j].id, shared, linkType: 'domain', score: shared.length });
    }
  }
}

// 2. Corrective links: AB↔CS in same domain (antibody has strategy as corrective pair)
const abNodes = nodes.filter(n => n.type === 'antibody');
const csNodes = nodes.filter(n => n.type === 'strategy');
for (const ab of abNodes) {
  for (const cs of csNodes) {
    const sharedDomains = ab.domains.filter(d => cs.domains.includes(d));
    if (sharedDomains.length === 0) continue;
    // Check text similarity between AB correction and CS pattern
    const abFull = antibodyFull.find(a => a.id === ab.id);
    const csFull = strategyFull.find(s => s.id === cs.id);
    if (!abFull || !csFull) continue;
    const sim = jaccardText(abFull.correction || '', csFull.pattern);
    if (sim > 0.15) {
      allLinks.push({ source: ab.id, target: cs.id, shared: sharedDomains, linkType: 'corrective', score: sim });
    }
  }
}

// 3. Same-domain cluster links (same primary domain, high severity/effectiveness)
const domainGroups = {};
nodes.forEach(n => { (domainGroups[n.domain] = domainGroups[n.domain] || []).push(n); });
Object.entries(domainGroups).forEach(([domain, group]) => {
  // Link top nodes within domain (by seen_count proxy via severity/effectiveness)
  const ranked = group.sort((a, b) => (b.seen || 0) - (a.seen || 0));
  for (let i = 0; i < Math.min(ranked.length, 8); i++) {
    for (let j = i + 1; j < Math.min(ranked.length, 8); j++) {
      if (ranked[i].type !== ranked[j].type) { // Prefer AB↔CS intra-domain
        allLinks.push({ source: ranked[i].id, target: ranked[j].id, shared: [domain], linkType: 'intra', score: 0.5 });
      }
    }
  }
});

// Limit links: bucket by type+domain pair, keep best
const byBucket = {};
allLinks.forEach(l => {
  const sN = nodes.find(n => n.id === l.source);
  const tN = nodes.find(n => n.id === l.target);
  if (!sN || !tN) return;
  const key = l.linkType + ':' + [sN.domain, tN.domain].sort().join('|');
  (byBucket[key] = byBucket[key] || []).push(l);
});
const keptLinks = [];
Object.values(byBucket).forEach(bucket => {
  bucket.sort((a, b) => b.score - a.score);
  keptLinks.push(...bucket.slice(0, 10));
});

// 6. Serialize all data
const DATA = {
  strategies: cheatsheet.strategies,
  antibodies: immune.antibodies,
  analysis: analysis,
  migration: migration,
  contextLogs,
  claudeMemories,
  growth,
  domainStats,
  nodes,
  links: keptLinks,
  domainColors,
  stats: {
    strategies: cheatsheet.stats,
    antibodies: immune.stats
  }
};

const dataJSON = JSON.stringify(DATA);

// 7. Generate HTML
const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mnemo — Immune Memory Visualization</title>
<script src="https://d3js.org/d3.v7.min.js"></script>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }

@keyframes pulse {
  0%, 100% { opacity: 0.6; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.02); }
}
@keyframes breathe {
  0%, 100% { filter: blur(0px); }
  50% { filter: blur(0.5px); }
}
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}

body {
  background: #0a0a0f;
  color: #e0e0e0;
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  overflow-x: hidden;
}

/* Organic background */
body::before {
  content: '';
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background:
    radial-gradient(ellipse at 20% 50%, rgba(79, 195, 247, 0.04) 0%, transparent 50%),
    radial-gradient(ellipse at 80% 20%, rgba(171, 71, 188, 0.04) 0%, transparent 50%),
    radial-gradient(ellipse at 50% 80%, rgba(102, 187, 106, 0.04) 0%, transparent 50%),
    radial-gradient(ellipse at 70% 60%, rgba(255, 167, 38, 0.03) 0%, transparent 40%);
  z-index: -1;
  animation: breathe 8s ease-in-out infinite;
}

.container {
  max-width: 1400px;
  margin: 0 auto;
  padding: 30px 20px;
}

/* Header */
.header {
  text-align: center;
  margin-bottom: 40px;
  animation: fadeIn 1s ease;
}
.header h1 {
  font-size: 2.5em;
  font-weight: 200;
  letter-spacing: 0.1em;
  background: linear-gradient(135deg, #4fc3f7, #ab47bc, #66bb6a);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  margin-bottom: 8px;
}
.header .subtitle {
  font-size: 1em;
  color: #666;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}

/* Stats Grid */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin-bottom: 40px;
  animation: fadeIn 1s ease 0.2s both;
}
.stat-card {
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 16px;
  padding: 24px;
  text-align: center;
  position: relative;
  overflow: hidden;
  transition: all 0.3s ease;
}
.stat-card:hover {
  background: rgba(255,255,255,0.06);
  border-color: rgba(255,255,255,0.12);
  transform: translateY(-2px);
}
.stat-card .glow {
  position: absolute;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  border-radius: 50%;
  opacity: 0.05;
}
.stat-card .value {
  font-size: 2.8em;
  font-weight: 100;
  letter-spacing: -0.02em;
  position: relative;
  opacity: 1;
}
.stat-card .label {
  font-size: 0.75em;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.15em;
  margin-top: 4px;
}

/* Section */
.section {
  margin-bottom: 50px;
  animation: fadeIn 1s ease 0.4s both;
}
.section-title {
  font-size: 1.4em;
  font-weight: 300;
  margin-bottom: 20px;
  color: #aaa;
  letter-spacing: 0.05em;
  display: flex;
  align-items: center;
  gap: 12px;
}
.section-title .icon {
  font-size: 1.2em;
}

/* Nebula */
#nebula {
  width: 100%;
  height: 550px;
  border-radius: 20px;
  background: rgba(0,0,0,0.3);
  border: 1px solid rgba(255,255,255,0.04);
  position: relative;
  overflow: hidden;
}
#nebula svg { width: 100%; height: 100%; }

/* Tooltip */
.tooltip {
  position: fixed;
  background: rgba(15, 15, 25, 0.95);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 12px;
  padding: 14px 18px;
  font-size: 0.85em;
  max-width: 350px;
  pointer-events: none;
  z-index: 1000;
  opacity: 0;
  transition: opacity 0.2s ease;
  backdrop-filter: blur(10px);
}
.tooltip.visible { opacity: 1; }
.tooltip .tt-id { font-weight: 600; margin-bottom: 4px; }
.tooltip .tt-type { font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.1em; opacity: 0.6; }
.tooltip .tt-pattern { margin-top: 8px; line-height: 1.5; color: #bbb; }
.tooltip .tt-domains { margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap; }
.tooltip .tt-domain {
  font-size: 0.7em;
  padding: 2px 8px;
  border-radius: 8px;
  background: rgba(255,255,255,0.08);
}

/* Timeline */
#timeline {
  width: 100%;
  height: 300px;
  border-radius: 20px;
  background: rgba(0,0,0,0.3);
  border: 1px solid rgba(255,255,255,0.04);
}

/* Domain bars */
.domain-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
}
.domain-card {
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 16px;
  padding: 20px;
  transition: all 0.3s ease;
}
.domain-card:hover { background: rgba(255,255,255,0.05); }
.domain-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.domain-dot {
  width: 12px; height: 12px;
  border-radius: 50%;
  box-shadow: 0 0 10px currentColor;
}
.domain-name { font-weight: 500; text-transform: capitalize; }
.domain-count { margin-left: auto; font-size: 0.8em; color: #888; }
.bar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 0.8em; }
.bar-label { width: 80px; color: #888; text-align: right; }
.bar-track { flex: 1; height: 6px; background: rgba(255,255,255,0.05); border-radius: 3px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 3px; transition: width 1s ease; }
.bar-value { width: 40px; color: #888; }

/* Memory graph */
#memory-graph {
  width: 100%;
  height: 450px;
  border-radius: 20px;
  background: rgba(0,0,0,0.3);
  border: 1px solid rgba(255,255,255,0.04);
  position: relative;
  overflow: hidden;
}
#memory-graph svg { width: 100%; height: 100%; }

/* Memory wall */
.memory-wall {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}
.memory-card {
  background: rgba(255,255,255,0.02);
  border: 1px solid rgba(255,255,255,0.05);
  border-radius: 14px;
  padding: 18px;
  transition: all 0.3s ease;
  position: relative;
  overflow: hidden;
}
.memory-card:hover { background: rgba(255,255,255,0.05); transform: translateY(-1px); }
.memory-card .mc-type {
  font-size: 0.65em;
  text-transform: uppercase;
  letter-spacing: 0.15em;
  padding: 2px 8px;
  border-radius: 6px;
  display: inline-block;
  margin-bottom: 8px;
}
.memory-card .mc-name { font-weight: 500; margin-bottom: 6px; font-size: 0.95em; }
.memory-card .mc-desc { font-size: 0.8em; color: #888; line-height: 1.5; }
.memory-card .mc-glow {
  position: absolute;
  top: 0; right: 0;
  width: 80px; height: 80px;
  border-radius: 50%;
  opacity: 0.05;
  transform: translate(30%, -30%);
}

/* Legend */
.legend {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
  margin-bottom: 16px;
  font-size: 0.8em;
  color: #888;
}
.legend-item { display: flex; align-items: center; gap: 6px; }
.legend-dot {
  width: 10px; height: 10px;
  border-radius: 50%;
}

/* Footer */
.footer {
  text-align: center;
  padding: 40px 0 20px;
  color: #444;
  font-size: 0.75em;
  letter-spacing: 0.1em;
}

/* Responsive */
@media (max-width: 768px) {
  .header h1 { font-size: 1.8em; }
  #nebula { height: 400px; }
  #timeline { height: 250px; }
  .stats-grid { grid-template-columns: repeat(2, 1fr); }
}
</style>
</head>
<body>

<div class="container">
  <div class="header">
    <h1>Mnemo</h1>
    <div class="subtitle">Immune Memory System &mdash; Live Visualization</div>
  </div>

  <div class="stats-grid" id="stats"></div>

  <div class="section">
    <div class="section-title"><span class="icon">&#x1F9EC;</span> Domain Nebula</div>
    <div class="legend" id="nebula-legend"></div>
    <div id="nebula"></div>
  </div>

  <div class="section">
    <div class="section-title"><span class="icon">&#x1F4C8;</span> Growth Timeline</div>
    <div id="timeline"></div>
  </div>

  <div class="section">
    <div class="section-title"><span class="icon">&#x1F4CA;</span> Domain Breakdown</div>
    <div class="domain-grid" id="domains"></div>
  </div>

  <div class="section">
    <div class="section-title"><span class="icon">&#x1F9E0;</span> Memory Network</div>
    <div id="memory-graph"></div>
  </div>

  <div class="section">
    <div class="section-title"><span class="icon">&#x1F4C4;</span> Memory Cards</div>
    <div class="memory-wall" id="claude-memories"></div>
  </div>

  <div class="section">
    <div class="section-title"><span class="icon">&#x1F504;</span> Context Logs</div>
    <div id="context-logs"></div>
  </div>

  <div class="footer">
    Mnemo v4.1 &bull; Immune + Cheatsheet + Context + Claude Memory &bull; Generated ${new Date().toISOString().split('T')[0]}
  </div>
</div>

<div class="tooltip" id="tooltip"></div>

<script>
const DATA = ${dataJSON};
const COLORS = DATA.domainColors;

// === STATS ===
(function() {
  const grid = document.getElementById('stats');
  const cards = [
    { value: DATA.stats.strategies.strategies_total, label: 'Strategies', color: '#66bb6a' },
    { value: DATA.stats.antibodies.antibodies_total, label: 'Antibodies', color: '#ef5350' },
    { value: DATA.stats.antibodies.outputs_checked, label: 'Outputs Scanned', color: '#4fc3f7' },
    { value: DATA.stats.antibodies.issues_caught, label: 'Issues Caught', color: '#ffa726' },
    { value: DATA.stats.strategies.strategies_applied, label: 'Strategies Applied', color: '#ab47bc' },
    { value: DATA.claudeMemories.length, label: 'Claude Memories', color: '#26c6da' },
    { value: DATA.contextLogs.length, label: 'Context Sessions', color: '#ffee58' },
    { value: DATA.analysis.corrections ? DATA.analysis.corrections.length : 0, label: 'Corrections Applied', color: '#ff7043' },
  ];
  cards.forEach(c => {
    const div = document.createElement('div');
    div.className = 'stat-card';
    div.innerHTML = '<div class="glow" style="background:' + c.color + '"></div>' +
      '<div class="value" style="color:' + c.color + '">' + c.value + '</div>' +
      '<div class="label">' + c.label + '</div>';
    grid.appendChild(div);
  });
})();

// === NEBULA (Force-directed) ===
(function() {
  const container = document.getElementById('nebula');
  const w = container.clientWidth, h = container.clientHeight;

  // Legend
  const legend = document.getElementById('nebula-legend');
  const typeColors = { strategy: '#66bb6a', antibody: '#ef5350' };
  ['strategy', 'antibody'].forEach(t => {
    legend.innerHTML += '<div class="legend-item"><div class="legend-dot" style="background:' + typeColors[t] + '"></div>' + t + '</div>';
  });
  // Link type legend
  const linkTypeColors = { domain: '#888', corrective: '#ff9100', intra: '#40c4ff' };
  const linkTypeLabels = { domain: 'cross-domain', corrective: 'AB\u2194CS', intra: 'intra-domain' };
  Object.entries(linkTypeLabels).forEach(([k, label]) => {
    legend.innerHTML += '<div class="legend-item"><div style="width:20px;height:2px;background:' + linkTypeColors[k] + ';border-radius:1px"></div>' + label + '</div>';
  });
  Object.entries(COLORS).forEach(([d, c]) => {
    if (DATA.domainStats[d]) {
      legend.innerHTML += '<div class="legend-item"><div class="legend-dot" style="background:' + c + ';opacity:0.6"></div>' + d + '</div>';
    }
  });

  const svg = d3.select('#nebula').append('svg').attr('viewBox', [0, 0, w, h]);

  // Glow filter
  const defs = svg.append('defs');
  const filter = defs.append('filter').attr('id', 'glow');
  filter.append('feGaussianBlur').attr('stdDeviation', '3').attr('result', 'blur');
  filter.append('feMerge').selectAll('feMergeNode')
    .data(['blur', 'SourceGraphic']).join('feMergeNode').attr('in', d => d);

  // Domain center forces
  const domainCenters = {};
  const domainList = Object.keys(DATA.domainStats);
  domainList.forEach((d, i) => {
    const angle = (i / domainList.length) * 2 * Math.PI - Math.PI / 2;
    const rx = w * 0.25, ry = h * 0.25;
    domainCenters[d] = { x: w/2 + rx * Math.cos(angle), y: h/2 + ry * Math.sin(angle) };
  });

  // Compute radius per node
  const nodes = DATA.nodes.map(n => ({
    ...n,
    r: n.type === 'strategy'
      ? 3 + n.effectiveness * 7
      : n.severity === 'critical' ? 8 : n.severity === 'warning' ? 6 : 4,
    x: w/2 + (Math.random() - 0.5) * 200,
    y: h/2 + (Math.random() - 0.5) * 200
  }));

  // Build link data from nodes
  const nodeById = {};
  nodes.forEach(n => nodeById[n.id] = n);
  const linkData = DATA.links.filter(l => nodeById[l.source] && nodeById[l.target])
    .map(l => ({ source: nodeById[l.source], target: nodeById[l.target], shared: l.shared, linkType: l.linkType, score: l.score }));

  const sim = d3.forceSimulation(nodes)
    .force('charge', d3.forceManyBody().strength(d => -d.r * 1.5))
    .force('center', d3.forceCenter(w/2, h/2).strength(0.05))
    .force('x', d3.forceX(d => domainCenters[d.domain]?.x || w/2).strength(0.15))
    .force('y', d3.forceY(d => domainCenters[d.domain]?.y || h/2).strength(0.15))
    .force('collide', d3.forceCollide().radius(d => d.r + 1).strength(0.8))
    .force('link', d3.forceLink(linkData).id(d => d.id).distance(60).strength(0.08))
    .alphaDecay(0.01);

  const tooltip = document.getElementById('tooltip');

  const linkTypeStroke = { domain: '#888', corrective: '#ff9100', intra: '#40c4ff' };
  // Draw links (behind nodes)
  const link = svg.selectAll('.link')
    .data(linkData).join('line')
    .attr('stroke', d => linkTypeStroke[d.linkType] || '#888')
    .attr('stroke-opacity', d => d.linkType === 'corrective' ? 0.7 : d.linkType === 'intra' ? 0.55 : 0.35)
    .attr('stroke-width', d => d.linkType === 'corrective' ? 3 : d.linkType === 'intra' ? 2.5 : 1.8)
    .attr('stroke-dasharray', d => d.linkType === 'corrective' ? '6,3' : d.linkType === 'intra' ? '3,3' : 'none');

  const node = svg.selectAll('circle')
    .data(nodes).join('circle')
    .attr('r', d => d.r)
    .attr('fill', d => {
      const base = COLORS[d.domain] || '#888';
      return d.type === 'strategy' ? base : d3.color(base).brighter(0.3);
    })
    .attr('fill-opacity', d => d.type === 'strategy' ? 0.7 : 0.5)
    .attr('stroke', d => COLORS[d.domain] || '#888')
    .attr('stroke-width', d => d.type === 'strategy' ? 1.5 : 0.8)
    .attr('stroke-opacity', 0.3)
    .style('filter', 'url(#glow)')
    .style('cursor', 'pointer')
    .on('mouseenter', function(event, d) {
      d3.select(this).attr('fill-opacity', 1).attr('stroke-opacity', 0.8).attr('r', d.r * 1.3);
      // Highlight connected links
      link.attr('stroke-opacity', l =>
        (l.source.id === d.id || l.target.id === d.id) ? 0.8 : 0.05
      ).attr('stroke-width', l =>
        (l.source.id === d.id || l.target.id === d.id) ? 3 : 0.5
      );
      // Find connected nodes
      const connected = linkData.filter(l => l.source.id === d.id || l.target.id === d.id)
        .map(l => l.source.id === d.id ? l.target : l.source);
      const connTypes = {};
      connected.forEach(c => { connTypes[c.type] = (connTypes[c.type]||0) + 1; });
      const connStr = Object.entries(connTypes).map(([t,n]) => n + ' ' + t + (n>1?'s':'')).join(', ');
      tooltip.innerHTML = '<div class="tt-type">' + d.type + '</div>' +
        '<div class="tt-id" style="color:' + (COLORS[d.domain]||'#888') + '">' + d.id + '</div>' +
        '<div class="tt-pattern">' + d.pattern + '</div>' +
        '<div class="tt-domains">' + d.domains.map(dm =>
          '<span class="tt-domain" style="border-color:' + COLORS[dm] + ';color:' + COLORS[dm] + '">' + dm + '</span>'
        ).join('') + '</div>' +
        (connected.length ? '<div style="margin-top:6px;font-size:0.8em;color:#888">Links: ' + connStr + '</div>' : '');
      tooltip.classList.add('visible');
    })
    .on('mousemove', function(event) {
      tooltip.style.left = (event.clientX + 16) + 'px';
      tooltip.style.top = (event.clientY - 10) + 'px';
    })
    .on('mouseleave', function(event, d) {
      d3.select(this).attr('fill-opacity', d.type === 'strategy' ? 0.7 : 0.5)
        .attr('stroke-opacity', 0.3).attr('r', d.r);
      link.attr('stroke-opacity', l => l.linkType === 'corrective' ? 0.7 : l.linkType === 'intra' ? 0.55 : 0.35)
        .attr('stroke-width', l => l.linkType === 'corrective' ? 3 : l.linkType === 'intra' ? 2.5 : 1.8);
      tooltip.classList.remove('visible');
    });

  sim.on('tick', () => {
    link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('cx', d => d.x).attr('cy', d => d.y);
  });
})();

// === TIMELINE ===
(function() {
  const container = document.getElementById('timeline');
  const w = container.clientWidth, h = container.clientHeight;
  const margin = { top: 30, right: 30, bottom: 40, left: 50 };
  const iw = w - margin.left - margin.right;
  const ih = h - margin.top - margin.bottom;

  const svg = d3.select('#timeline').append('svg').attr('viewBox', [0, 0, w, h]);
  const g = svg.append('g').attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

  const x = d3.scaleTime()
    .domain(d3.extent(DATA.growth, d => new Date(d.date)))
    .range([0, iw]);
  const y = d3.scaleLinear()
    .domain([0, d3.max(DATA.growth, d => d.total) * 1.1])
    .range([ih, 0]);

  // Axes
  g.append('g').attr('transform', 'translate(0,' + ih + ')')
    .call(d3.axisBottom(x).ticks(6).tickFormat(d3.timeFormat('%b %d')))
    .call(g => g.select('.domain').attr('stroke', '#333'))
    .call(g => g.selectAll('.tick line, .tick text').attr('stroke', '#444').attr('fill', '#666'));

  g.append('g')
    .call(d3.axisLeft(y).ticks(5))
    .call(g => g.select('.domain').attr('stroke', '#333'))
    .call(g => g.selectAll('.tick line, .tick text').attr('stroke', '#444').attr('fill', '#666'));

  // Area strategies
  const areaS = d3.area()
    .x(d => x(new Date(d.date)))
    .y0(ih).y1(d => y(d.strategies))
    .curve(d3.curveMonotoneX);
  g.append('path').datum(DATA.growth)
    .attr('d', areaS).attr('fill', 'rgba(102,187,106,0.15)').attr('stroke', '#66bb6a').attr('stroke-width', 2);

  // Area antibodies
  const areaA = d3.area()
    .x(d => x(new Date(d.date)))
    .y0(ih).y1(d => y(d.antibodies))
    .curve(d3.curveMonotoneX);
  g.append('path').datum(DATA.growth)
    .attr('d', areaA).attr('fill', 'rgba(239,83,80,0.1)').attr('stroke', '#ef5350').attr('stroke-width', 2);

  // Labels
  svg.append('text').attr('x', margin.left + 10).attr('y', margin.top + 10)
    .attr('fill', '#66bb6a').attr('font-size', '0.75em').text('Strategies');
  svg.append('text').attr('x', margin.left + 100).attr('y', margin.top + 10)
    .attr('fill', '#ef5350').attr('font-size', '0.75em').text('Antibodies');
})();

// === DOMAIN BREAKDOWN ===
(function() {
  const grid = document.getElementById('domains');
  Object.entries(DATA.domainStats).sort((a,b) => b[1].total - a[1].total).forEach(([domain, s]) => {
    const color = COLORS[domain] || '#888';
    const card = document.createElement('div');
    card.className = 'domain-card';

    const maxVal = Math.max(s.strategies, s.antibodies, 1);
    let bars = '';
    if (s.strategies) {
      const effPct = Math.round(s.avgEff * 100);
      bars += '<div class="bar-row"><div class="bar-label">Strategies</div><div class="bar-track"><div class="bar-fill" style="width:' +
        (s.strategies / maxVal * 100) + '%;background:' + color + ';opacity:0.7"></div></div><div class="bar-value">' + s.strategies + '</div></div>';
      bars += '<div class="bar-row"><div class="bar-label">Avg Eff.</div><div class="bar-track"><div class="bar-fill" style="width:' +
        effPct + '%;background:' + color + ';opacity:0.4"></div></div><div class="bar-value">' + effPct + '%</div></div>';
    }
    if (s.antibodies) {
      bars += '<div class="bar-row"><div class="bar-label">Antibodies</div><div class="bar-track"><div class="bar-fill" style="width:' +
        (s.antibodies / maxVal * 100) + '%;background:' + color + ';opacity:0.5"></div></div><div class="bar-value">' + s.antibodies + '</div></div>';
      if (s.critical) bars += '<div class="bar-row"><div class="bar-label">Critical</div><div class="bar-track"><div class="bar-fill" style="width:' +
        (s.critical / s.antibodies * 100) + '%;background:#ef5350;opacity:0.6"></div></div><div class="bar-value">' + s.critical + '</div></div>';
    }

    card.innerHTML = '<div class="domain-header"><div class="domain-dot" style="color:' + color + ';background:' + color + '"></div>' +
      '<div class="domain-name">' + domain + '</div><div class="domain-count">' + s.total + ' items</div></div>' + bars;
    grid.appendChild(card);
  });
})();

// === MEMORY NETWORK ===
(function() {
  const container = document.getElementById('memory-graph');
  const w = container.clientWidth, h = container.clientHeight;

  const svg = d3.select('#memory-graph').append('svg').attr('viewBox', [0, 0, w, h]);

  const tooltip = document.getElementById('tooltip');

  // Build nodes: Claude memories + Immune domain clusters
  const memNodes = DATA.claudeMemories.map((m, i) => ({
    id: 'mem_' + i, label: m.name, type: 'memory', memType: m.type,
    desc: m.description, size: 30
  }));

  const domainNodes = Object.entries(DATA.domainStats).map(([d, s]) => ({
    id: 'dom_' + d, label: d, type: 'domain', domain: d, total: s.total,
    size: 15 + s.total * 0.5
  }));

  // Special nodes
  const specialNodes = [
    { id: 'spec_immune', label: 'Immune System', type: 'special', desc: 'Cheatsheet + Antibodies + Context', size: 40 },
    { id: 'spec_mnemoclaw', label: 'MnemoClaw', type: 'special', desc: 'Docker + Gateway + Guardian + WhatsApp', size: 35 },
  ];

  const allNodes = [...memNodes, ...domainNodes, ...specialNodes];
  const nodeById = {};
  allNodes.forEach(n => { n.x = w/2 + (Math.random()-0.5)*100; n.y = h/2 + (Math.random()-0.5)*100; nodeById[n.id] = n; });

  // Build links based on content relationships
  const links = [];
  // User memory links to everything
  const userMem = memNodes.find(n => n.memType === 'user');
  if (userMem) {
    memNodes.filter(n => n !== userMem).forEach(n => links.push({ source: userMem.id, target: n.id, strength: 0.3 }));
    links.push({ source: userMem.id, target: 'spec_mnemoclaw', strength: 0.4 });
  }

  // MnemoClaw project links to immune + mnemoclaw node
  const mnemoclawMem = memNodes.find(n => n.label.includes('MnemoClaw'));
  if (mnemoclawMem) {
    links.push({ source: mnemoclawMem.id, target: 'spec_mnemoclaw', strength: 0.6 });
    links.push({ source: mnemoclawMem.id, target: 'spec_immune', strength: 0.5 });
  }

  // Remotion links to MnemoClaw (runs in docker)
  const remotionMem = memNodes.find(n => n.label.includes('Remotion'));
  if (remotionMem) {
    links.push({ source: remotionMem.id, target: 'spec_mnemoclaw', strength: 0.4 });
  }

  // Feedback links to user
  const feedbackMem = memNodes.find(n => n.memType === 'feedback');
  if (feedbackMem && userMem) {
    links.push({ source: feedbackMem.id, target: userMem.id, strength: 0.5 });
  }

  // Immune system node links to all domains
  domainNodes.forEach(dn => {
    links.push({ source: 'spec_immune', target: dn.id, strength: 0.2 });
  });

  // Cross-domain links (shared domains between strategies)
  const domainKeys = Object.keys(DATA.domainStats);
  const codeWeb = domainNodes.find(n => n.domain === 'code');
  const fitnessWeb = domainNodes.find(n => n.domain === 'fitness');
  const writingWeb = domainNodes.find(n => n.domain === 'writing');
  const webdesignWeb = domainNodes.find(n => n.domain === 'webdesign');
  const travelWeb = domainNodes.find(n => n.domain === 'travel');
  // Known cross-domain connections from data
  if (codeWeb && webdesignWeb) links.push({ source: codeWeb.id, target: webdesignWeb.id, strength: 0.3 });
  if (codeWeb && fitnessWeb) links.push({ source: codeWeb.id, target: fitnessWeb.id, strength: 0.2 });
  if (fitnessWeb && writingWeb) links.push({ source: fitnessWeb.id, target: writingWeb.id, strength: 0.2 });
  if (travelWeb && writingWeb) links.push({ source: travelWeb.id, target: writingWeb.id, strength: 0.2 });
  if (codeWeb && writingWeb) links.push({ source: codeWeb.id, target: writingWeb.id, strength: 0.15 });

  const typeColors = { user: '#4fc3f7', feedback: '#ffa726', project: '#66bb6a', reference: '#ab47bc', domain: null, special: '#e0e0e0' };

  // Draw links
  const link = svg.selectAll('.mlink')
    .data(links).join('line')
    .attr('stroke', '#555')
    .attr('stroke-opacity', d => d.strength)
    .attr('stroke-width', d => 1 + d.strength * 3);

  // Draw nodes
  const node = svg.selectAll('.mnode')
    .data(allNodes).join('g')
    .style('cursor', 'pointer')
    .on('mouseenter', function(event, d) {
      tooltip.innerHTML = '<div class="tt-type" style="color:' + (typeColors[d.memType] || typeColors[d.type] || '#888') + '">' + (d.memType || d.type) + '</div>' +
        '<div class="tt-id">' + d.label + '</div>' +
        (d.desc ? '<div class="tt-pattern">' + d.desc + '</div>' : '') +
        (d.total ? '<div class="tt-pattern">' + d.total + ' items</div>' : '');
      tooltip.classList.add('visible');
    })
    .on('mousemove', function(event) {
      tooltip.style.left = (event.clientX + 16) + 'px';
      tooltip.style.top = (event.clientY - 10) + 'px';
    })
    .on('mouseleave', function() {
      tooltip.classList.remove('visible');
    });

  node.append('circle')
    .attr('r', d => d.size)
    .attr('fill', d => {
      if (d.type === 'domain') return COLORS[d.domain] || '#888';
      return typeColors[d.memType || d.type] || '#888';
    })
    .attr('fill-opacity', d => d.type === 'domain' ? 0.15 : 0.25)
    .attr('stroke', d => {
      if (d.type === 'domain') return COLORS[d.domain] || '#888';
      return typeColors[d.memType || d.type] || '#888';
    })
    .attr('stroke-width', d => d.type === 'special' ? 2 : 1.5)
    .attr('stroke-opacity', 0.6);

  node.append('text')
    .text(d => d.label.length > 18 ? d.label.substring(0, 16) + '..' : d.label)
    .attr('text-anchor', 'middle')
    .attr('dy', '0.35em')
    .attr('fill', d => {
      if (d.type === 'domain') return COLORS[d.domain] || '#ccc';
      return '#ccc';
    })
    .attr('font-size', d => d.type === 'special' ? '0.85em' : '0.75em')
    .attr('font-weight', d => d.type === 'special' ? '600' : '400')
    .style('pointer-events', 'none');

  const sim = d3.forceSimulation(allNodes)
    .force('charge', d3.forceManyBody().strength(d => -d.size * 3))
    .force('center', d3.forceCenter(w/2, h/2).strength(0.1))
    .force('collide', d3.forceCollide().radius(d => d.size + 5))
    .force('link', d3.forceLink(links).id(d => d.id).distance(d => 80 + (1 - d.strength) * 60).strength(d => d.strength * 0.3))
    .alphaDecay(0.02);

  sim.on('tick', () => {
    link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');
  });
})();

// === MEMORY CARDS (text) ===
(function() {
  const wall = document.getElementById('claude-memories');
  const typeColors = { user: '#4fc3f7', feedback: '#ffa726', project: '#66bb6a', reference: '#ab47bc' };
  DATA.claudeMemories.forEach(m => {
    const color = typeColors[m.type] || '#888';
    const card = document.createElement('div');
    card.className = 'memory-card';
    card.innerHTML = '<div class="mc-glow" style="background:' + color + '"></div>' +
      '<div class="mc-type" style="background:' + color + '22;color:' + color + '">' + m.type + '</div>' +
      '<div class="mc-name">' + m.name + '</div>' +
      '<div class="mc-desc">' + m.description + '</div>';
    wall.appendChild(card);
  });
  if (!DATA.claudeMemories.length) {
    wall.innerHTML = '<div style="color:#555">No Claude memories found</div>';
  }
})();

// === CONTEXT LOGS ===
(function() {
  const el = document.getElementById('context-logs');
  if (!DATA.contextLogs.length) {
    el.innerHTML = '<div style="color:#555;font-size:0.9em">No context sessions logged</div>';
    return;
  }
  DATA.contextLogs.forEach(log => {
    const div = document.createElement('div');
    div.style.cssText = 'background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);border-radius:12px;padding:16px;margin-bottom:12px;font-size:0.85em;line-height:1.6;color:#999;';
    div.innerHTML = '<strong style="color:#aaa">' + log.file + '</strong><br>' + log.content;
    el.appendChild(div);
  });
})();
</script>
</body>
</html>`;

// Write
const outPath = path.join(DIR, 'immune-viz.html');
fs.writeFileSync(outPath, html, 'utf8');
console.log('Generated:', outPath);
console.log('Size:', (html.length / 1024).toFixed(0) + ' KB');
console.log('Data:', DATA.nodes.length, 'nodes,', Object.keys(DATA.domainStats).length, 'domains');
console.log('Claude memories:', DATA.claudeMemories.length);
console.log('Context logs:', DATA.contextLogs.length);
