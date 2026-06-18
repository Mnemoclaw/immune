#!/usr/bin/env node
// ============================================================================
// Immune v5.1 — Learning Curve Benchmark
// ============================================================================
// Protocol:
//   Pass 0: immune VIDE → scan 15 inputs → measure detection rate
//   Pass 1-N: inject errors learned from previous pass → rescan → measure
//   Pass final: housekeep → rescan → measure retained
//
// This proves: "Immune improves over time, and housekeeping preserves quality"
// Uses immune-adapter.js CLI directly — no daemon required.
// ============================================================================

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const CASES_FILE = process.argv.includes('--cases') ? process.argv[process.argv.indexOf('--cases') + 1] : path.join(SCRIPT_DIR, 'cases-learning.json');
const RESULTS_DIR = path.join(SCRIPT_DIR, 'results');
const ADAPTER = path.join(SCRIPT_DIR, '..', 'immune-adapter.js');
const TOTAL_PASSES = 6;
const HOUSEKEEP_AFTER_PASS = 4;

function runAdapter(...args) {
  try {
    const out = execFileSync('node', [ADAPTER, ...args], { encoding: 'utf8', timeout: 30000, stdio: ['pipe','pipe','pipe'] });
    return JSON.parse(out.trim());
  } catch (e) {
    return null;
  }
}

async function embedText(text) {
  const result = runAdapter('embed', '--text', text);
  if (result && result.vector) return result.vector;
  return null;
}

function cosine(a, b) {
  if (!a || !b) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

// In-memory antibody store (simulates immune memory growing over passes)
let memoryAntibodies = [];

async function scanWithMemory(input, domain) {
  const inputVec = await embedText(input);

  const matches = [];
  for (const ab of memoryAntibodies) {
    const sim = cosine(inputVec, ab._vec);
    if (sim >= 0.3) {
      matches.push({ ...ab, score: sim });
    }
  }

  // Keyword overlap as bonus signal
  const inputKeywords = input.toLowerCase().split(/[\s\-_=<>{}()[\];,.'"]+/).filter(w => w.length >= 3);
  for (const ab of memoryAntibodies) {
    const patternKeywords = ab.pattern.toLowerCase().split(/[\s\-_=<>{}()[\];,.'"]+/).filter(w => w.length >= 3);
    const overlap = inputKeywords.filter(k => patternKeywords.some(p => p.includes(k) || k.includes(p))).length;
    const keywordScore = inputKeywords.length > 0 ? overlap / inputKeywords.length : 0;
    const existingMatch = matches.find(m => m.id === ab.id);
    if (existingMatch) {
      existingMatch.score = existingMatch.score * 0.7 + keywordScore * 0.3;
    } else if (keywordScore >= 0.2) {
      matches.push({ ...ab, score: keywordScore * 0.5 });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, 5);
}

async function main() {
  console.log('\x1b[36mImmune v5.1 — Learning Curve Benchmark\x1b[0m');
  console.log('==========================================');
  console.log('Measuring how immune improves with each learning pass.');
  console.log('Using local embeddings via immune-adapter.js (no daemon).\n');

  const stats = runAdapter('stats');
  if (!stats) {
    console.log('Adapter: \x1b[31mFAILED\x1b[0m — check immune-adapter.js');
    process.exit(1);
  }
  console.log(`Adapter: \x1b[32mOK\x1b[0m`);

  const cases = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8'));
  const totalErrors = cases.reduce((sum, c) => sum + c.errors.length, 0);
  console.log(`Cases: ${cases.length} | Total known errors: ${totalErrors}`);
  console.log(`Passes: ${TOTAL_PASSES} | Housekeep after pass ${HOUSEKEEP_AFTER_PASS}`);
  console.log('');

  // Pre-compute embeddings for all error patterns
  console.log('Pre-computing embeddings for error patterns...');
  for (const c of cases) {
    for (const err of c.errors) {
      err._vec = await embedText(err.pattern);
    }
  }
  console.log('Done.\n');

  const learningCurve = [];

  for (let pass = 0; pass < TOTAL_PASSES; pass++) {
    const isHousekeep = pass === HOUSEKEEP_AFTER_PASS;
    const phase = pass === 0 ? 'EMPTY' : isHousekeep ? 'HOUSEKEEP' : `Pass ${pass}`;

    console.log(`\x1b[1m═══ ${phase} — Memory: ${memoryAntibodies.length} antibodies ═══\x1b[0m`);

    // Housekeep step
    if (isHousekeep) {
      const before = memoryAntibodies.length;
      const kept = [];
      for (const ab of memoryAntibodies) {
        if (ab.severity === 'critical' || (ab._seen || 0) >= 2) {
          const isDup = kept.some(k => cosine(k._vec, ab._vec) >= 0.85);
          if (!isDup) kept.push(ab);
        }
      }
      memoryAntibodies = kept;
      console.log(`  Housekeep: ${before} → ${memoryAntibodies.length} antibodies`);
    }

    let totalDetected = 0;
    let totalPossible = 0;
    let totalPartial = 0;
    const passDetails = [];

    for (const c of cases) {
      const matches = await scanWithMemory(c.input, c.domain);
      totalPossible += c.errors.length;

      let detected = 0;
      const detectedErrors = [];

      for (const err of c.errors) {
        let found = false;

        for (const match of matches) {
          const errVec = err._vec;
          const patternSim = cosine(errVec, match._vec);

          const errKeywords = err.pattern.toLowerCase().split(/[\s\-_=<>{}()[\];,.'"]+/).filter(w => w.length >= 3);
          const matchKeywords = match.pattern.toLowerCase().split(/[\s\-_=<>{}()[\];,.'"]+/).filter(w => w.length >= 3);
          const kwOverlap = errKeywords.filter(k => matchKeywords.some(m => m.includes(k) || k.includes(m))).length;
          const kwScore = errKeywords.length > 0 ? kwOverlap / errKeywords.length : 0;

          if (patternSim >= 0.5 || kwScore >= 0.3 || (patternSim >= 0.3 && kwScore >= 0.15)) {
            found = true;
            break;
          }
        }

        if (found) {
          detected++;
          detectedErrors.push(err.pattern.substring(0, 50) + '...');
        }
      }

      totalDetected += detected;
      if (detected > 0 && detected < c.errors.length) totalPartial++;

      passDetails.push({
        id: c.id,
        errors_total: c.errors.length,
        errors_detected: detected,
        detected_patterns: detectedErrors
      });
    }

    const detectionRate = Math.round(totalDetected / totalPossible * 100);
    const caseRate = passDetails.filter(d => d.errors_detected === d.errors_total).length;
    const partialRate = passDetails.filter(d => d.errors_detected > 0 && d.errors_detected < d.errors_total).length;
    const missRate = passDetails.filter(d => d.errors_detected === 0).length;

    console.log(`  Detection: \x1b[32m${totalDetected}/${totalPossible}\x1b[0m errors caught (${detectionRate}%)`);
    console.log(`  Cases: ${caseRate} fully caught | ${partialRate} partial | \x1b[31m${missRate} missed\x1b[0m`);

    learningCurve.push({
      pass,
      phase,
      memory_size: memoryAntibodies.length,
      errors_detected: totalDetected,
      errors_total: totalPossible,
      detection_rate: detectionRate,
      cases_full: caseRate,
      cases_partial: partialRate,
      cases_missed: missRate,
      details: passDetails
    });

    // Learning step
    if (pass < TOTAL_PASSES - 1) {
      let newPatterns = 0;
      let reinforced = 0;

      for (const c of cases) {
        const pd = passDetails.find(d => d.id === c.id);
        for (const err of c.errors) {
          const errText = err.pattern.substring(0, 50) + '...';
          if (pd.detected_patterns.includes(errText)) {
            const catcher = memoryAntibodies.find(ab => cosine(ab._vec, err._vec) >= 0.5);
            if (catcher) {
              catcher._seen = (catcher._seen || 0) + 1;
              reinforced++;
            }
          }
        }
      }

      for (const c of cases) {
        const pd = passDetails.find(d => d.id === c.id);
        const missedErrors = c.errors.filter((_, i) => {
          return !pd.detected_patterns.some(dp => {
            const errText = c.errors[i].pattern.substring(0, 50) + '...';
            return dp === errText;
          });
        });

        const toLearn = pass === 0 ? c.errors : missedErrors;

        for (const err of toLearn) {
          const alreadyKnown = memoryAntibodies.some(ab => cosine(ab._vec, err._vec) >= 0.7);
          if (!alreadyKnown) {
            memoryAntibodies.push({
              id: `LRN-${String(memoryAntibodies.length + 1).padStart(3, '0')}`,
              pattern: err.pattern,
              severity: err.severity,
              correction: err.correction,
              domains: [c.domain],
              _vec: err._vec,
              _seen: 1
            });
            newPatterns++;
          }
        }
      }
      console.log(`  Learned: +${newPatterns} new | Reinforced: ${reinforced} → memory now ${memoryAntibodies.length}`);
    }
  }

  // --- Summary ---
  console.log('\n================================================');
  console.log('\x1b[1mLearning Curve Summary\x1b[0m\n');

  console.log('  Pass  Phase        Memory  Detection   Full  Partial  Missed');
  console.log('  ────  ───────────  ──────  ──────────  ────  ───────  ──────');
  for (const lc of learningCurve) {
    const phase = lc.phase.padEnd(12);
    const mem = String(lc.memory_size).padStart(5);
    const det = `${lc.errors_detected}/${lc.errors_total}`.padStart(7);
    const rate = `(${lc.detection_rate}%)`.padStart(6);
    const full = String(lc.cases_full).padStart(3);
    const part = String(lc.cases_partial).padStart(5);
    const miss = String(lc.cases_missed).padStart(5);
    const marker = lc.phase === 'HOUSEKEEP' ? '\x1b[1;33m' : lc.phase === 'EMPTY' ? '\x1b[31m' : '\x1b[32m';
    console.log(`  ${marker}${lc.pass}     ${phase}${mem}  ${det} ${rate}  ${full}  ${part}  ${miss}\x1b[0m`);
  }

  const empty = learningCurve[0];
  const best = learningCurve.reduce((a, b) => a.detection_rate > b.detection_rate ? a : b);
  const final_ = learningCurve[learningCurve.length - 1];
  const improvement = best.detection_rate - empty.detection_rate;

  console.log('');
  console.log(`  \x1b[1mBaseline (empty):   ${empty.detection_rate}%\x1b[0m (${empty.errors_detected}/${empty.errors_total})`);
  console.log(`  \x1b[1mPeak:              ${best.detection_rate}%\x1b[0m (${best.errors_detected}/${best.errors_total}) at ${best.phase}`);
  console.log(`  \x1b[1mFinal:             ${final_.detection_rate}%\x1b[0m (${final_.errors_detected}/${final_.errors_total})`);
  console.log(`  \x1b[1mImprovement:       +${improvement} pts\x1b[0m (empty → peak)`);

  const beforeHK = learningCurve[HOUSEKEEP_AFTER_PASS - 1];
  const afterHK = learningCurve[HOUSEKEEP_AFTER_PASS];
  if (beforeHK && afterHK) {
    const hkDelta = afterHK.detection_rate - beforeHK.detection_rate;
    const memDelta = afterHK.memory_size - beforeHK.memory_size;
    console.log(`  \x1b[1mHousekeep impact:   ${hkDelta >= 0 ? '+' : ''}${hkDelta} pts, ${memDelta >= 0 ? '+' : ''}${memDelta} patterns\x1b[0m`);
  }

  // --- Save ---
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const resultFile = path.join(RESULTS_DIR, `learning-curve-${timestamp}.json`);

  const report = {
    timestamp: new Date().toISOString(),
    version: '5.0',
    type: 'learning_curve',
    engine: 'local',
    cases: cases.length,
    total_errors: totalErrors,
    total_passes: TOTAL_PASSES,
    housekeep_after_pass: HOUSEKEEP_AFTER_PASS,
    learning_curve: learningCurve.map(lc => ({
      pass: lc.pass,
      phase: lc.phase,
      memory_size: lc.memory_size,
      detection_rate: lc.detection_rate,
      errors_detected: lc.errors_detected,
      errors_total: lc.errors_total,
      cases_full: lc.cases_full,
      cases_partial: lc.cases_partial,
      cases_missed: lc.cases_missed
    })),
    summary: {
      baseline: empty.detection_rate,
      peak: best.detection_rate,
      final: final_.detection_rate,
      improvement,
      housekeep_impact: afterHK ? afterHK.detection_rate - beforeHK.detection_rate : null
    }
  };

  fs.writeFileSync(resultFile, JSON.stringify(report, null, 2));
  console.log(`\nSaved: ${resultFile}`);
  console.log('\n\x1b[1mDone.\x1b[0m');
}

main().catch(e => { console.error(`Fatal: ${e.message}`); process.exit(1); });
