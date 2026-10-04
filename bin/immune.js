#!/usr/bin/env node
// @mnemoclaw/immune — installer CLI
// Subcommands: init (default), stats, version, help
// Pure Node CJS, cross-platform (Windows/macOS/Linux). No shell-specific code.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const PKG = require("../package.json");
const VERSION = PKG.version;
const PKG_NAME = PKG.name;
const MIN_NODE_MAJOR = 18;

// Files/dirs shipped by the npm package that must be copied into the skill dir.
// Anything user-generated stays out of this list — user data remains entirely user-owned.
const RUNTIME_FILES = [
  "immune-adapter.js",
  "immune-inject.js",
  "sanitizer.js",
  "config.yaml",
  "skill.md",
  "package.json",
];
const RUNTIME_DIRS = ["agents"];

// Files that, if they already exist in the skill dir, identify a prior install
// whose memory must be preserved across upgrades.
const USER_PRESERVED = [
  "immune_memory.json",
  "cheatsheet_memory.json",
  "migration_state.json",
  "analysis.json",
  "USER.md",
];
// Anything a user could have written lives under these names and must never be
// treated as "no user data": the memory files themselves count. A user whose
// memory only exists as JSON (sqlite not created yet) still has data, and being
// told "no user data — overwriting cleanly" is both wrong and alarming.
const USER_PRESERVED_GLOBS = [
  "immune_memory.json",
  "cheatsheet_memory.json",
  "immune.sqlite",
  "immune.sqlite-", // covers -shm, -wal suffixes
  "archived_",
  "context",
];

function log(...args) {
  process.stdout.write(args.join(" ") + "\n");
}
function err(...args) {
  process.stderr.write(args.join(" ") + "\n");
}

function nodeMajor() {
  const m = /^v?(\d+)/.exec(process.version);
  return m ? parseInt(m[1], 10) : 0;
}

function checkNode() {
  if (nodeMajor() < MIN_NODE_MAJOR) {
    err(
      `[immune] Node ${process.version} detected — requires Node ${MIN_NODE_MAJOR}+.`,
      `Install from https://nodejs.org/ and re-run \`immune init\`.`
    );
    process.exit(1);
  }
}

function skillDir() {
  return path.join(os.homedir(), ".claude", "skills", "immune");
}

function srcDir() {
  // bin/immune.js → package root (where immune-adapter.js lives).
  return path.resolve(__dirname, "..");
}

function copyFile(src, dst) {
  // Atomic-ish: write to tmp then rename. Avoids corrupting on Ctrl-C.
  const tmp = dst + ".tmp-" + process.pid;
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dst);
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else copyFile(s, d);
  }
}

// Returns true if any user-generated file/dir is present (signals prior install).
function hasUserData(dir) {
  for (const name of USER_PRESERVED) {
    if (fs.existsSync(path.join(dir, name))) return true;
  }
  for (const prefix of USER_PRESERVED_GLOBS) {
    try {
      const entries = fs.readdirSync(dir);
      for (const e of entries) {
        if (e.startsWith(prefix)) return true;
      }
    } catch {
      // dir doesn't exist yet — nothing to preserve
    }
  }
  return false;
}

function installedVersion(dir) {
  try {
    const p = JSON.parse(
      fs.readFileSync(path.join(dir, "package.json"), "utf8")
    );
    return p.version || null;
  } catch {
    return null;
  }
}

function npmBin() {
  // On Windows, the executable is npm.cmd (PATH lookup works without shell).
  // On Unix, npm is a shebang script resolvable directly from PATH.
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

// Node >= 22 refuses to spawn a .cmd/.bat directly (spawnSync returns EINVAL),
// so on Windows npm must go through a shell. Arguments here are ours (package
// name, fixed flags) and are quoted individually before being concatenated.
function quoteWinArg(s) {
  const v = String(s);
  return /[\s"^&|<>]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function runNpm(args, opts = {}) {
  const isWin = process.platform === "win32";
  const res = spawnSync(
    isWin ? [npmBin(), ...args].map(quoteWinArg).join(" ") : npmBin(),
    isWin ? [] : args,
    {
      cwd: opts.cwd,
      stdio: opts.stdio || "inherit",
      encoding: opts.encoding,
      timeout: opts.timeout,
      windowsHide: true,
      ...(isWin ? { shell: true } : {}),
    }
  );
  return res;
}

function runNpmInstall(cwd) {
  log("[immune] Installing dependencies (this may take a minute on first run)…");
  const result = runNpm(["install", "--omit=dev", "--no-fund", "--no-audit"], { cwd });
  if (result.status !== 0) {
    err(
      `[immune] npm install failed (exit ${result.status}${
        result.error ? `, ${result.error.code}` : ""
      }).`
    );
    return false;
  }
  return true;
}

function verifyAdapter(cwd) {
  const result = spawnSync(
    process.execPath,
    ["immune-adapter.js", "stats"],
    { cwd, stdio: "inherit" }
  );
  return result.status === 0;
}

function cmdInit() {
  checkNode();

  const dst = skillDir();
  const src = srcDir();
  const fresh = !fs.existsSync(dst);

  log(`[immune] v${VERSION} → ${dst}`);

  // Detect upgrade vs fresh install
  const prevVersion = !fresh ? installedVersion(dst) : null;
  const sameVersion = prevVersion && prevVersion === VERSION;

  if (fresh) {
    fs.mkdirSync(dst, { recursive: true });
    log("[immune] Fresh install.");
  } else if (hasUserData(dst)) {
    log(
      `[immune] Existing skill detected (v${prevVersion || "unknown"}, user memory preserved).`
    );
  } else {
    log("[immune] Existing skill dir, no user data — overwriting cleanly.");
  }

  // Copy runtime files (always overwrite — they're ours).
  for (const f of RUNTIME_FILES) {
    const s = path.join(src, f);
    if (!fs.existsSync(s)) {
      err(`[immune] Missing source file: ${f} — package is corrupt.`);
      process.exit(1);
    }
    copyFile(s, path.join(dst, f));
  }
  for (const d of RUNTIME_DIRS) {
    const s = path.join(src, d);
    if (fs.existsSync(s)) copyDir(s, path.join(dst, d));
  }

  // Skip npm install when version unchanged (idempotent upgrades), unless forced.
  const skipNpm = sameVersion && !process.env.IMMUNE_FORCE_NPM;
  if (skipNpm) {
    log(`[immune] Same version already installed — skipping npm install.`);
    log(`[immune] (set IMMUNE_FORCE_NPM=1 to force reinstall of deps.)`);
  } else {
    if (!runNpmInstall(dst)) process.exit(1);
  }

  // Verify
  // Refresh the update cache BEFORE verifying: a verification failure exits the
  // process, and an update notice is exactly what the user needs at that point.
  refreshUpdateCache();
  notifyUpdate();
  log("[immune] Verifying…");
  if (!verifyAdapter(dst)) {
    err("[immune] Verification failed — see errors above.");
    err("[immune] If the skill dir was edited by hand, re-run with IMMUNE_FORCE_NPM=1");
    err("[immune] (forces a clean reinstall of the dependencies).");
    err(`[immune] Skill dir: ${dst}`);
    process.exit(1);
  }

  log("");
  log("✓ Immune installed.");
  log("");
  log("Usage in Claude Code:");
  log("  /immune Check this function for common pitfalls");
  log("  /immune domain=domain Vérifie ce programme");
  log("");
  log("First /immune call downloads the embedding model (~22 MB, one-time).");
  log("Optional pre-generation hook: see README → Automatic Pre-Generation Injection.");
}

function cmdStats() {
  const dst = skillDir();
  const adapter = path.join(dst, "immune-adapter.js");
  if (!fs.existsSync(adapter)) {
    err(`[immune] Skill not installed at ${dst}. Run \`immune init\` first.`);
    process.exit(1);
  }
  const result = spawnSync(process.execPath, [adapter, "stats"], {
    cwd: dst,
    stdio: "inherit",
  });
  process.exit(result.status || 0);
}

function cmdVersion() {
  log(`@mnemoclaw/immune v${VERSION} (paquet npm)`);

  // The runtime the agent actually executes is the COPY in the skill dir, so a
  // new npm version changes nothing until `immune init` refreshes it. Showing
  // both versions makes that version skew visible instead of mysterious.
  const dst = skillDir();
  const installed = installedVersion(dst);
  if (installed && installed !== VERSION) {
    log(`Skill dir: ${dst} -> v${installed} (different du paquet)`);
    log(`  pour appliquer la v${VERSION} : immune init`);
  } else if (installed) {
    log(`Skill dir: ${dst} -> v${installed} (a jour)`);
  } else {
    log(`Skill dir: ${dst} -> pas encore installe (lancez \`immune init\`)`);
  }
  notifyUpdate();
}

// ── Mise a jour : verification npm une fois par jour, sans bloquant ──
// Aucun appel reseau dans le chemin critique : le cache est lu au demarrage et
// rafraichi une fois par 24 h, en fin de `immune init`. Hors ligne, echec
// silencieux ; aucune donnee n'est envoyee ailleurs que le registre npm.

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 5000;

function updateCachePath() {
  return path.join(skillDir(), ".update-check.json");
}

function readUpdateCache() {
  try {
    return JSON.parse(fs.readFileSync(updateCachePath(), "utf8"));
  } catch {
    return null;
  }
}

// Compare "5.3.10" et "v5.3.9" -> 1 / -1 / 0
function cmpSemver(a, b) {
  const pa = String(a).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function refreshUpdateCache() {
  const cache = readUpdateCache();
  if (cache && typeof cache.checkedAt === "number") {
    if (Date.now() - cache.checkedAt < UPDATE_CHECK_INTERVAL_MS) return cache;
  }
  try {
    const res = runNpm(["view", PKG_NAME, "version"], {
      encoding: "utf8",
      timeout: UPDATE_CHECK_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const latest = (res.stdout || "").trim();
    if (res.status === 0 && /^v?\d+\.\d+\.\d+/.test(latest)) {
      const next = { checkedAt: Date.now(), latest };
      try {
        fs.writeFileSync(updateCachePath(), JSON.stringify(next));
      } catch {
        /* skill dir non inscriptible : on garde le cache en memoire */
      }
      return next;
    }
  } catch {
    /* pas de reseau : on ignore */
  }
  return cache;
}

function notifyUpdate() {
  const cache = readUpdateCache();
  if (!cache || !cache.latest) return;
  if (cmpSemver(cache.latest, VERSION) > 0) {
    log("");
    log(`[immune] v${cache.latest} est disponible (vous utilisez v${VERSION}).`);
    log(`  npm update -g ${PKG_NAME} && immune`);
    log("  Les deux etapes sont necessaires : le code utilise par l'agent est une");
    log("  copie dans le skill dir, rafraichie par \`immune init\`.");
  }
}

function cmdHelp() {
  log(`@mnemoclaw/immune v${VERSION} — hybrid adaptive memory for AI agents`);
  log("");
  log("Usage:");
  log("  immune init        Install/upgrade skill into ~/.claude/skills/immune/");
  log("  immune stats       Show antibody/strategy counts (proxies adapter)");
  log("  immune version     Print package version");
  log("  immune help        Show this message");
  log("");
  log("Default action when no argument is given: init.");
  log("");
  log("Mise a jour :");
  log(`  npm update -g ${PKG_NAME} && immune`);
  log("  (l'etape \`immune\` est obligatoire : l'agent execute une copie des");
  log("  fichiers dans ~/.claude/skills/immune/, rafraichie par init.)");
  log("");
  log("Environment:");
  log("  IMMUNE_FORCE_NPM=1   Force npm install even if version unchanged.");
  log("");
  log("Documentation: https://github.com/Mnemoclaw/immune");
}

function main() {
  const cmd = process.argv[2] || "init";
  switch (cmd) {
    case "init":
    case "install":
      cmdInit();
      break;
    case "stats":
      cmdStats();
      break;
    case "version":
    case "--version":
    case "-v":
      cmdVersion();
      break;
    case "help":
    case "--help":
    case "-h":
      cmdHelp();
      break;
    default:
      err(`[immune] Unknown command: ${cmd}`);
      err("Run `immune help` for usage.");
      process.exit(1);
  }
}

main();
