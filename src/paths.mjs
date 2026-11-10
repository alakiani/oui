// Where everything lives. One home directory holds all state, so a restart
// (or a different terminal) picks up exactly where things were.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OUI_BIN = path.join(ROOT, "bin", "oui.mjs");
export const DEFAULT_PORT = 7330;

export function home() {
  return process.env.OUI_HOME ? path.resolve(process.env.OUI_HOME) : path.join(os.homedir(), ".ouichef");
}

export const P = {
  state: () => path.join(home(), "state.json"),
  events: () => path.join(home(), "events.jsonl"),
  ledger: () => path.join(home(), "ledger.jsonl"),
  daemon: () => path.join(home(), "daemon.json"),
  config: () => path.join(home(), "config.json"),
  policy: () => path.join(home(), "policy.json"),
  notes: () => path.join(home(), "notes", "chef.md"),
  daemonLog: () => path.join(home(), "daemon.log"),
  tasks: () => path.join(home(), "tickets"),
  task: (id) => path.join(home(), "tickets", id),
  roles: () => path.join(home(), "roles"),
  worktrees: () => path.join(home(), "worktrees"),
  sous: () => path.join(home(), "sous"),
};

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// Write-then-rename, so a crash can never leave a half-written file behind.
export function writeJsonAtomic(file, value, mode) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

export function appendLine(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(value) + "\n");
}

export const DEFAULT_CONFIG = {
  port: DEFAULT_PORT,
  maxCooks: 3, // cook running at once, across all projects
  harness: "claude", // "claude" | "stub"
  model: null, // cook model; null = the harness default
  sousModel: null, // model for the first/inspector's short judgment calls
  calls: { triage: true, review: true, plan: true },
  maxAttempts: 3, // times a ticket may be sent back before the chef is asked
  maxNudges: 2, // times a cook that stopped without reporting is nudged
  turnTimeoutMinutes: 120,
  roleTimeoutMinutes: 10,
  budgetUsdPerTurn: null,
};

export function loadConfig() {
  const user = readJson(P.config(), {}) ?? {};
  return { ...DEFAULT_CONFIG, ...user, calls: { ...DEFAULT_CONFIG.calls, ...(user.calls ?? {}) } };
}
