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
const MIN_NODE_MAJOR = 18;

// Files/dirs shipped by the npm package that must be copied into the skill dir.
// Anything user-generated is intentionally absent here — we never touch it.
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
const USER_PRESERVED_GLOBS = [
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

function runNpmInstall(cwd) {
  log("[immune] Installing dependencies (this may take a minute on first run)…");
  const result = spawnSync(
    npmBin(),
    ["install", "--omit=dev", "--no-fund", "--no-audit"],
    { cwd, stdio: "inherit" }
  );
  if (result.status !== 0) {
    err(`[immune] npm install failed (exit ${result.status}).`);
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
  log("[immune] Verifying…");
  if (!verifyAdapter(dst)) {
    err("[immune] Verification failed — see errors above.");
    err(`[immune] Skill dir: ${dst}`);
    process.exit(1);
  }

  log("");
  log("✓ Immune installed.");
  log("");
  log("Usage in Claude Code:");
  log("  /immune Check this function for common pitfalls");
  log("  /immune domain=fitness Vérifie ce programme");
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
  log(`@mnemoclaw/immune v${VERSION}`);
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
