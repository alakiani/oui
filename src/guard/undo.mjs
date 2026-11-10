// Checkpoints and undo. Before a recorded command runs, the guard saves what it
// is about to change (a manifest, a commit id, a release revision). The undo
// recipe refers to those files, so "put it back" is a concrete command, written
// down before anything happened.

import fs from "node:fs";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { ensureDir } from "../paths.mjs";

const DROP_META = ["resourceVersion", "uid", "creationTimestamp", "generation", "managedFields", "selfLink", "deletionTimestamp", "deletionGracePeriodSeconds"];

// A live object, cleaned so `kubectl apply -f` can recreate it.
function cleanK8s(text) {
  if (!text.trim()) return "";
  const doc = JSON.parse(text);
  const items = doc.kind === "List" || Array.isArray(doc.items) ? doc.items ?? [] : [doc];
  if (!items.length) return "";
  for (const item of items) {
    delete item.status;
    for (const key of DROP_META) delete item.metadata?.[key];
    const notes = item.metadata?.annotations;
    if (notes) delete notes["deployment.kubernetes.io/revision"];
  }
  return JSON.stringify({ apiVersion: "v1", kind: "List", items }, null, 1);
}

function clean(kind, text) {
  try {
    if (kind === "k8s") return cleanK8s(text);
    if (kind === "helmrev") return String(JSON.parse(text)?.[0]?.revision ?? "");
  } catch {
    return kind === "helmrev" ? "" : text;
  }
  return text;
}

function run(argv, opts) {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs ?? 15000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout ?? "", stderr: String(stderr ?? error?.message ?? "").slice(0, 400) });
    });
  });
}

// Runs each capture and writes its output into `dir`. Never throws: a failed
// capture is reported, and the command it belongs to still runs.
export async function capture(specs, dir, opts = {}) {
  if (!specs?.length) return [];
  ensureDir(dir);
  return Promise.all(
    specs.map(async (spec) => {
      const res = await run(spec.argv, { cwd: spec.cwd ?? opts.cwd, env: opts.env });
      const text = res.ok ? clean(spec.sanitize, res.stdout) : "";
      fs.writeFileSync(path.join(dir, spec.name), text);
      return { name: spec.name, ok: res.ok, bytes: text.length, error: res.ok ? null : res.stderr };
    }),
  );
}

const readTrim = (file) => {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
};

// Fill in an undo recipe from its checkpoint. A step that needs a value the
// checkpoint does not have is marked `missing` instead of being guessed.
export function renderUndo(undoList, dir) {
  return (undoList ?? []).map((undo) => {
    const empty = undo.ifEmpty && !readTrim(path.join(dir, undo.ifEmpty.file));
    const use = empty ? { ...undo, ...undo.ifEmpty } : undo;
    let missing = false;
    const steps = (use.steps ?? []).map((step) =>
      step
        .replace(/\{dir\}/g, dir)
        .replace(/\{@([^}]+)\}/g, (_m, name) => {
          const value = readTrim(path.join(dir, name));
          if (!value) missing = true;
          return value || `<missing ${name}>`;
        }),
    );
    return { summary: use.summary, steps, note: empty ? undefined : undo.note, for: undo.for ?? null, missing };
  });
}

// Runs a rendered recipe, stopping at the first step that fails.
export function runUndo(rendered, cwd, env = process.env) {
  const results = [];
  for (const recipe of rendered) {
    if (recipe.missing) {
      results.push({ step: recipe.summary, ok: false, output: "The checkpoint is incomplete, so this cannot be undone automatically." });
      return { ok: false, results };
    }
    for (const step of recipe.steps) {
      const res = spawnSync("sh", ["-c", step], { cwd, env, encoding: "utf8", timeout: 120000 });
      const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim().slice(-1200);
      results.push({ step, ok: res.status === 0, output });
      if (res.status !== 0) return { ok: false, results };
    }
  }
  return { ok: true, results };
}
