// Git plumbing for the expediter. Each goal gets an integration branch; each
// build ticket gets its own worktree cut from it. Finished tickets are merged into
// the goal branch, so later tickets start from everything that came before, and
// the chef approves one landing per goal instead of one per ticket.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { P, ensureDir } from "./paths.mjs";

export function git(cwd, args, opts = {}) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", timeout: opts.timeoutMs ?? 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(opts.env ?? {}) } });
  return { ok: res.status === 0, out: (res.stdout ?? "").trim(), err: (res.stderr ?? "").trim() || res.error?.message || "" };
}

const hasBranch = (repo, branch) => git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]).ok;

export function ensureBranch(repo, branch, from) {
  if (hasBranch(repo, branch)) return { ok: true };
  return git(repo, ["branch", branch, from]);
}

export function ensureWorktree(repo, dir, branch, from) {
  if (fs.existsSync(path.join(dir, ".git"))) return { ok: true, reused: true };
  ensureDir(path.dirname(dir));
  git(repo, ["worktree", "prune"]);
  return hasBranch(repo, branch) ? git(repo, ["worktree", "add", dir, branch]) : git(repo, ["worktree", "add", "-b", branch, dir, from]);
}

export function removeWorktree(repo, dir) {
  if (!fs.existsSync(dir)) return;
  if (!git(repo, ["worktree", "remove", "--force", dir]).ok) fs.rmSync(dir, { recursive: true, force: true });
  git(repo, ["worktree", "prune"]);
}

export const goalWorktree = (project, goal) => path.join(P.worktrees(), project.id, goal.id);

// Merge a finished ticket into its goal branch. On a conflict nothing is left
// half-merged: the cook that owns the ticket branch is asked to resolve it.
export function integrate(project, goal, task) {
  const dir = goalWorktree(project, goal);
  const wt = ensureWorktree(project.path, dir, goal.branch, project.base);
  if (!wt.ok) return { ok: false, error: wt.err };
  const ahead = git(dir, ["rev-list", "--count", `${goal.branch}..${task.branch}`]);
  if (ahead.ok && ahead.out === "0") return { ok: true, empty: true };
  const res = git(dir, ["merge", "--no-ff", "--no-edit", "-m", `${task.id}: ${task.title}`, task.branch], { env: identity() });
  if (res.ok) return { ok: true };
  const files = git(dir, ["diff", "--name-only", "--diff-filter=U"]).out.split("\n").filter(Boolean);
  git(dir, ["merge", "--abort"]);
  return { ok: false, conflict: files.length > 0, files, error: res.err || res.out };
}

// Commits Oui Chef makes itself (merges) need an author even on a fresh machine.
function identity() {
  const have = spawnSync("git", ["config", "user.email"], { encoding: "utf8" }).stdout?.trim();
  return have ? {} : { GIT_AUTHOR_NAME: "Oui Chef", GIT_AUTHOR_EMAIL: "ouichef@localhost", GIT_COMMITTER_NAME: "Oui Chef", GIT_COMMITTER_EMAIL: "ouichef@localhost" };
}

export function uncommitted(dir) {
  const res = git(dir, ["status", "--porcelain"]);
  return res.ok ? res.out.split("\n").filter(Boolean) : [];
}

export function diffStat(repo, from, to) {
  const res = git(repo, ["diff", "--shortstat", `${from}...${to}`]);
  return res.ok ? res.out : "";
}

// Fast-forward the base branch to the goal branch. Returns the commit the base
// was on, so the landing can be undone.
export function landLocal(project, goal) {
  const repo = project.path;
  const dir = goalWorktree(project, goal);
  const wt = ensureWorktree(repo, dir, goal.branch, project.base);
  if (!wt.ok) return { ok: false, error: wt.err };
  const before = git(repo, ["rev-parse", project.base]);
  if (!before.ok) return { ok: false, error: `No branch ${project.base} in ${repo}` };
  // Bring the goal branch up to date with the base first, so the base only ever moves forward.
  const sync = git(dir, ["merge", "--no-edit", project.base], { env: identity() });
  if (!sync.ok) {
    const files = git(dir, ["diff", "--name-only", "--diff-filter=U"]).out;
    git(dir, ["merge", "--abort"]);
    return { ok: false, error: `${project.base} has moved and now conflicts with ${goal.branch}${files ? ` in ${files.split("\n").join(", ")}` : ""}` };
  }
  const current = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).out;
  const res = current === project.base ? git(repo, ["merge", "--ff-only", goal.branch]) : git(repo, ["fetch", ".", `${goal.branch}:${project.base}`]);
  if (!res.ok) return { ok: false, error: res.err || res.out };
  const undo = current === project.base ? `git -C ${repo} reset --hard ${before.out}` : `git -C ${repo} update-ref refs/heads/${project.base} ${before.out}`;
  return { ok: true, before: before.out, after: git(repo, ["rev-parse", project.base]).out, undo, checkedOut: current === project.base };
}

// Push the goal branch and open one pull request for the whole goal.
export function landPr(project, goal, body, existing) {
  const repo = project.path;
  const push = git(repo, ["push", "-u", "origin", `${goal.branch}:${goal.branch}`], { timeoutMs: 180000 });
  if (!push.ok) return { ok: false, error: `git push failed: ${push.err}` };
  if (existing) return { ok: true, url: existing, undo: null }; // the pull request is already open; the push updated it
  const pr = spawnSync("gh", ["pr", "create", "--base", project.base, "--head", goal.branch, "--title", goal.title, "--body", body], { cwd: repo, encoding: "utf8", timeout: 120000 });
  if (pr.status !== 0) return { ok: false, pushed: true, error: `The branch is pushed, but gh pr create failed: ${(pr.stderr ?? pr.error?.message ?? "").trim()}` };
  const url = (pr.stdout ?? "").trim().split("\n").pop();
  return { ok: true, url, undo: `gh pr close ${url} --delete-branch` };
}
