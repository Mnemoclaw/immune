#!/usr/bin/env node
'use strict';

// immune-inject.js — Pre-generation strategy injection hook
// Called by Claude Code UserPromptSubmit hook before every prompt.
// Reads prompt → detects domains → loads HOT strategies → outputs compact XML.
// Zero external deps. Silent on any error (graceful degradation).

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const CONFIG_PATH = path.join(DIR, 'config.yaml');
const CHEATSHEET_PATH = path.join(DIR, 'cheatsheet_memory.json');

const MAX_STRATEGIES = 5;

// ── Helpers ──────────────────────────────────────────────

function daysDiff(dateStr) {
  if (!dateStr) return Infinity;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return Infinity;
  return (Date.now() - d.getTime()) / 86400000;
}

function isHotStrategy(cs) {
  if ((cs.effectiveness || 0) >= 0.7) return true;
  if ((cs.seen_count || 0) >= 3) return true;
  if (daysDiff(cs.last_seen) < 30) return true;
  return false;
}

// ── Config parsing (lightweight, no yaml lib) ────────────

function parseDomainKeywords(configPath) {
  try {
    const yaml = fs.readFileSync(configPath, 'utf8');
    const keywords = {};
    let inSection = false;
    for (const line of yaml.split('\n')) {
      if (/^domain_keywords\s*:/.test(line)) { inSection = true; continue; }
      if (inSection && /^\s{2}\w/.test(line) && line.includes('[')) {
        const m = line.match(/^\s*(\w+)\s*:\s*\[([^\]]*)\]/);
        if (m) {
          keywords[m[1]] = m[2].split(',').map(k => k.trim().replace(/"/g, '').replace(/'/g, '')).filter(Boolean);
        }
      } else if (inSection && /^\S/.test(line)) {
        break; // next section
      }
    }
    return keywords;
  } catch {
    return {};
  }
}

// ── Domain detection ─────────────────────────────────────

function detectDomains(prompt, domainKeywords) {
  const lower = (' ' + prompt.toLowerCase() + ' ');
  const scores = {};

  for (const [domain, keywords] of Object.entries(domainKeywords)) {
    if (domain === '_global') continue;
    let hits = 0;
    for (const kw of keywords) {
      // Word boundary check — prevent "France" matching "API"
      const pattern = '\\b' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b';
      if (new RegExp(pattern, 'i').test(lower)) hits++;
    }
    if (hits > 0) scores[domain] = hits;
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const domains = [];

  if (sorted.length > 0 && sorted[0][1] >= 2) {
    domains.push(sorted[0][0]);
    if (sorted.length > 1 && sorted[1][1] >= sorted[0][1] - 1 && sorted[1][1] >= 1) {
      domains.push(sorted[1][0]);
    }
  } else if (sorted.length > 0 && sorted[0][1] >= 1) {
    domains.push(sorted[0][0]);
  }

  // Only include _global if a specific domain was detected
  // (avoids noise on unrelated prompts like "What is the capital of France?")
  if (domains.length > 0) {
    domains.push('_global');
  }

  return [...new Set(domains)];
}

// ── Strategy loading ─────────────────────────────────────

function loadHotStrategies(jsonPath, domains) {
  try {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.strategies)) return [];

    return data.strategies
      .filter(cs => {
        if (!isHotStrategy(cs)) return false;
        const csDomains = cs.domains || [];
        return domains.some(d => csDomains.includes(d));
      })
      .sort((a, b) => (b.effectiveness || 0) - (a.effectiveness || 0))
      .slice(0, MAX_STRATEGIES);
  } catch {
    return [];
  }
}

// ── Output formatting ────────────────────────────────────

function formatCompact(strategies) {
  if (strategies.length === 0) return '';
  const items = strategies.map(s => {
    const id = s.id || '?';
    const eff = (s.effectiveness || 0).toFixed(1);
    const pattern = (s.pattern || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    return `<s id="${id}" e="${eff}">${pattern}</s>`;
  }).join('\n');
  return `<imm>\n${items}\n</imm>`;
}

// ── Main ─────────────────────────────────────────────────

try {
  // Read stdin (hook passes JSON with prompt field)
  let input = '';

  if (process.stdin.isTTY) {
    // No piped input — nothing to do
    process.exit(0);
  }

  input = fs.readFileSync(0, 'utf8').trim(); // fd 0 = stdin, works on Windows

  if (!input) process.exit(0);

  let promptText = '';
  try {
    const parsed = JSON.parse(input);
    promptText = parsed.prompt || parsed.message || '';
  } catch {
    // Not JSON — treat raw text as prompt
    promptText = input;
  }

  if (!promptText || promptText.length < 3) process.exit(0);

  // Sanitize
  try {
    const { sanitize } = require('./sanitizer');
    promptText = sanitize(promptText);
  } catch { /* no sanitizer, continue raw */ }

  // Detect domains
  const domainKeywords = parseDomainKeywords(CONFIG_PATH);
  const domains = detectDomains(promptText, domainKeywords);

  // Load strategies
  const strategies = loadHotStrategies(CHEATSHEET_PATH, domains);

  // Output
  const output = formatCompact(strategies);
  if (output) {
    process.stdout.write(output + '\n');
  }
} catch (err) {
  // Silent degradation — never break Claude's flow
  if (process.env.IMMUNE_DEBUG) process.stderr.write('immune-inject: ' + err.message + '\n');
}

process.exit(0);
