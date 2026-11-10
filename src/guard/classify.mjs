// The guard's judgement: given a tool call an agent is about to make, how risky
// is it, why, and how would it be put back? Pure apart from two injected
// lookups (current git branch, current kube context), so it is fully testable.
//
// This is a seatbelt, not a sandbox. It reads commands the way a careful person
// would and catches the mistakes of an eager agent. It cannot stop a program
// that hides what it does.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { baseName, parseArgs, parseShell, sh, unwrap } from "./shell.mjs";
import { hasProdWord, hasRiskyName, isProtectedBranch, kubeZone, matchesAny } from "./policy.mjs";
import { ROLE_VERBS, RULES, tierOf } from "./rules.mjs";

export const defaultLookup = {
  gitBranch(cwd) {
    try {
      return execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch {
      return null;
    }
  },
  kubeContext(env, kubeconfig) {
    try {
      const args = [...(kubeconfig ? ["--kubeconfig", kubeconfig] : []), "config", "current-context"];
      return execFileSync("kubectl", args, { encoding: "utf8", timeout: 3000, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch {
      return null;
    }
  },
};

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const INTERPRETERS = new Set(["python", "python3", "node", "ruby", "perl", "php", "deno", "bun"]);
const AGENTS = new Set(["claude", "codex", "gemini", "opencode", "aider", "cursor-agent", "amp", "droid", "goose", "grok", "pi"]);

// Programs that only look. Anything here can run as root or over ssh without a second thought.
const READERS = new Set([
  "ls", "cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "ag", "fd", "wc", "sort", "uniq", "cut", "tr", "echo", "printf", "pwd", "cd",
  "test", "[", "true", "false", "date", "whoami", "id", "hostname", "uname", "printenv", "which", "type", "stat", "file", "du", "df", "ps", "top", "htop",
  "free", "uptime", "jq", "yq", "diff", "cmp", "tree", "basename", "dirname", "realpath", "readlink", "sleep", "nproc", "lsof", "netstat", "ss", "ping", "dig",
  "nslookup", "host", "journalctl", "dmesg", "env", "sha256sum", "md5sum", "base64", "column", "nl", "seq", "tac", "rev", "xxd", "od", "strings", "lsblk", "mount",
  "ip", "ifconfig", "arch", "sw_vers", "getent", "groups", "last", "w", "who", "history", "man", "help", "awk", "export", "set", "source", ".", "wait", "read",
]);

// ---- helpers

// One folder can be reached by more than one spelling: through a symlink, or on macOS
// where /var is really /private/var. Paths are compared by where they really point.
// A path that does not exist yet takes the real location of its nearest existing parent.
export function real(p) {
  let current = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

function resolvePath(ctx, p) {
  if (!p) return null;
  let s = p.replace(/^~(?=\/|$)/, os.homedir()).replace(/\$\{?HOME\}?/g, os.homedir());
  if (/[$`]/.test(s) || s.includes("$(…)")) return null; // depends on something only the shell knows
  s = s.replace(/[*?[].*$/, ""); // a glob: judge the folder it expands in
  return real(path.resolve(ctx.cwd ?? "/", s || "."));
}

const within = (root, p) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const TMP = [...new Set([os.tmpdir(), "/tmp", "/private/tmp", "/var/tmp"].flatMap((p) => [path.resolve(p), real(p)]))];

function inWorkspace(ctx, abs) {
  if (!abs) return false;
  const where = real(abs);
  return [...(ctx.roots ?? []), ...TMP].some((r) => within(r, where));
}

// A path whose loss would be a disaster wherever the agent is working.
function isRootish(ctx, abs) {
  if (!abs) return true;
  const homeDir = real(os.homedir());
  if (abs === "/" || abs === homeDir || within(abs, homeDir)) return true;
  if ((ctx.roots ?? []).some((r) => abs !== r && within(abs, r))) return true; // a parent of the station
  return abs.split(path.sep).filter(Boolean).length <= 1 && !TMP.includes(abs);
}

const envSaysProd = (ctx, keys) => keys.some((k) => hasProdWord(ctx.policy, ctx.env?.[k]));
const DB_ENV = ["DATABASE_URL", "DB_URL", "DB_HOST", "PGHOST", "PGDATABASE", "MYSQL_HOST", "MONGO_URL", "MONGODB_URI", "REDIS_URL", "RAILS_ENV", "RACK_ENV", "NODE_ENV", "APP_ENV", "ENVIRONMENT", "ENV", "DJANGO_SETTINGS_MODULE"];

function make(ctx, rule, why, extra = {}) {
  return { rule, tier: tierOf(rule, ctx.policy), about: RULES[rule]?.[1] ?? rule, why, ...extra };
}
const READ = { read: true }; // the program was recognised and only looks

// ---- git

const GIT_READ = new Set(["status", "log", "diff", "show", "fetch", "rev-parse", "rev-list", "ls-files", "ls-remote", "ls-tree", "blame", "describe", "shortlog", "cat-file", "grep", "bisect", "reflog", "merge-base", "name-rev", "show-ref", "for-each-ref", "check-ignore", "diff-tree", "whatchanged", "version", "help", "var", "count-objects", "fsck", "verify-commit", "range-diff", "format-patch", "archive", "bundle", "notes", "init", "clone", "add", "mv", "rm", "apply", "stash", "lfs", "sparse-checkout", "maintenance"]);
const GIT_COMMITTING = new Set(["commit", "merge", "rebase", "cherry-pick", "revert", "am", "pull", "reset", "checkout", "switch", "restore", "tag", "remote", "config", "submodule", "worktree", "update-ref", "symbolic-ref", "clean", "gc", "prune"]);

function git(argv, ctx) {
  let cwd = ctx.cwd;
  let rest = argv.slice(1);
  while (rest.length && rest[0].startsWith("-")) {
    const flag = rest.shift();
    if (flag === "-C") cwd = real(path.resolve(cwd ?? "/", rest.shift() ?? "."));
    else if (["-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"].includes(flag)) rest.shift();
  }
  const verb = rest[0];
  if (!verb) return READ;
  const args = rest.slice(1);
  const here = inWorkspace(ctx, cwd);
  const extra = ctx.protectedBranches ?? [];
  const guarded = (b) => isProtectedBranch(ctx.policy, b, extra);
  const at = cwd && cwd !== ctx.cwd ? ["git", "-C", cwd] : ["git"];

  if (verb === "push") return gitPush(args, ctx, cwd, guarded, at);

  if (["filter-branch", "filter-repo"].includes(verb) || (verb === "reflog" && ["expire", "delete"].includes(args[0])) || (verb === "gc" && args.some((a) => a.startsWith("--prune"))) || (verb === "update-ref" && args.includes("-d")))
    return make(ctx, "git.history.rewrite", `git ${verb} rewrites or discards history`);

  if (verb === "branch") {
    const { pos, opts } = parseArgs(args);
    const deleting = opts.has("D") || opts.has("d") || opts.has("delete");
    if (!deleting) return opts.has("m") || opts.has("M") || opts.has("f") ? (here ? {} : make(ctx, "git.outside.change", `renames or moves a branch in ${cwd}`)) : READ;
    const hit = pos.find(guarded);
    if (hit) return make(ctx, "git.branch.delete.protected", `deletes the protected branch ${hit}`);
    const n = ctx.seq.n++;
    return make(ctx, "git.branch.delete", `deletes branch ${pos.join(", ")}`, {
      capture: pos.map((b, i) => ({ name: `${n}-${i}-sha.txt`, argv: [...at, "rev-parse", "--verify", "-q", `refs/heads/${b}`] })),
      undo: { summary: "Recreate the branch at the commit it pointed to", steps: pos.map((b, i) => `${sh([...at, "branch", b])} {@${n}-${i}-sha.txt}`) },
    });
  }

  if (GIT_READ.has(verb) && !(verb === "stash" && ["drop", "clear"].includes(args[0])) && !(verb === "notes" && args[0] === "remove")) return verb === "add" || verb === "rm" || verb === "mv" || verb === "apply" || verb === "stash" || verb === "init" || verb === "clone" ? {} : READ;

  if (here) {
    // The cook's own worktree: committing, rebasing and resetting there is the job.
    if (["checkout", "switch"].includes(verb)) return {};
    return {};
  }

  const branch = ctx.lookup.gitBranch(cwd);
  const discards = (verb === "reset" && args.includes("--hard")) || verb === "clean" || (verb === "stash" && ["drop", "clear"].includes(args[0])) || (verb === "checkout" && (args.includes("--") || args.includes("."))) || verb === "restore";
  if (discards) return make(ctx, "git.outside.discard", `git ${verb} would discard uncommitted work in ${cwd}, which is not the cook's station`);
  if (GIT_COMMITTING.has(verb)) {
    if (guarded(branch) && ["commit", "merge", "rebase", "cherry-pick", "revert", "am", "pull", "reset"].includes(verb)) return make(ctx, "git.outside.protected", `git ${verb} changes the protected branch ${branch} in ${cwd}`);
    const n = ctx.seq.n++;
    return make(ctx, "git.outside.change", `git ${verb} in ${cwd}, outside the cook's station`, {
      capture: [{ name: `${n}-head.txt`, argv: ["git", "-C", cwd, "rev-parse", "HEAD"] }],
      undo: { summary: `Put ${branch ?? "the branch"} back where it was`, steps: [`${sh(["git", "-C", cwd, "reset", "--hard"])} {@${n}-head.txt}`], note: "Only safe while nothing else has been committed on top." },
    });
  }
  return {};
}

function gitPush(args, ctx, cwd, guarded, at) {
  const { pos, opts } = parseArgs(args, ["--repo", "-o", "--push-option", "--receive-pack", "--exec", "--recurse-submodules"]);
  const remote = pos[0] ?? "origin";
  const specs = pos.slice(1).filter((s) => s !== "tag");
  const force = ["f", "force", "force-with-lease", "force-if-includes"].some((k) => opts.has(k)) || specs.some((s) => s.startsWith("+"));
  const del = opts.has("d") || opts.has("delete") || specs.some((s) => s.startsWith(":"));
  if (opts.has("mirror") || (opts.has("all") && force)) return make(ctx, "git.push.mirror", `overwrites every ref on ${remote}`);
  if (opts.has("dry-run") || opts.has("n")) return READ;
  let branches = specs
    .filter((s) => !s.startsWith("refs/tags/"))
    .map((s) => s.replace(/^\+/, ""))
    .map((s) => (s.includes(":") ? s.split(":")[1] : s))
    .map((s) => s.replace(/^refs\/heads\//, ""));
  if (!branches.length || branches.includes("HEAD")) branches = [...branches.filter((b) => b !== "HEAD"), ctx.lookup.gitBranch(cwd)].filter(Boolean);
  const hot = branches.find(guarded);
  if (hot) {
    if (del) return make(ctx, "git.push.delete.protected", `deletes the protected branch ${hot} on ${remote}`);
    if (force) return make(ctx, "git.push.force.protected", `force-pushes the protected branch ${hot} on ${remote}`);
    return make(ctx, "git.push.protected", `pushes straight to the protected branch ${hot} on ${remote}`);
  }
  const n = ctx.seq.n++;
  const capture = branches.map((b, i) => ({ name: `${n}-${i}-remote.txt`, argv: [...at, "rev-parse", "--verify", "-q", `refs/remotes/${remote}/${b}`] }));
  const list = branches.join(", ") || "the current branch";
  if (del) return make(ctx, "git.push.delete", `deletes ${list} on ${remote}`, { capture, undo: { summary: "Push the branch back at the commit it had", steps: branches.map((b, i) => `${sh([...at, "push", remote])} {@${n}-${i}-remote.txt}:refs/heads/${b}`) } });
  const undo = {
    summary: "Put the remote branch back to the commit it had before this push",
    steps: branches.map((b, i) => `${sh([...at, "push", "--force-with-lease", remote])} {@${n}-${i}-remote.txt}:refs/heads/${b}`),
    ifEmpty: { file: `${n}-0-remote.txt`, steps: branches.map((b) => sh([...at, "push", remote, "--delete", b])), summary: "The branch was new on the remote: delete it there" },
  };
  return make(ctx, force ? "git.push.force" : "git.push", `${force ? "force-pushes" : "pushes"} ${list} to ${remote}`, { capture, undo });
}

// ---- GitHub and GitLab CLIs

const FORGE_VALUED = ["-R", "--repo", "-B", "--base", "-H", "--head", "-t", "--title", "-b", "--body", "-F", "--body-file", "-f", "--field", "--raw-field", "-X", "--method", "--input", "-r", "--ref", "-q", "--jq", "--json", "-L", "--limit", "-l", "--label", "-a", "--assignee", "-m", "--milestone", "--subject", "--template", "-w", "--workflow", "--branch", "-e", "--env", "--org"];

function forge(argv, ctx) {
  const prog = baseName(argv[0]);
  const { pos, opts, multi } = parseArgs(argv.slice(1), FORGE_VALUED);
  const [group, action] = pos;
  const whole = argv.slice(1).join(" ");
  const repoFlags = opts.get("R") || opts.get("repo") ? ["-R", opts.get("R") ?? opts.get("repo")] : [];
  if (!group || opts.has("help")) return READ;
  const readActions = new Set(["view", "list", "ls", "status", "checks", "diff", "watch", "download", "show", "get", "search", "trace", "lint", undefined]);

  if (group === "pr" || group === "mr") {
    if (action === "merge") {
      const id = pos[2];
      const n = ctx.seq.n++;
      return make(ctx, "forge.pr.merge", `merges ${group === "pr" ? "pull request" : "merge request"} ${id ?? "(current branch)"}`, {
        capture: prog === "gh" ? [{ name: `${n}-pr.json`, argv: ["gh", "pr", "view", ...(id ? [id] : []), ...repoFlags, "--json", "number,url,baseRefName,headRefName,headRefOid,title"] }] : [],
        undo: {
          summary: "Revert the merge with a new pull request",
          steps: prog === "gh" ? [sh(["gh", "pr", "revert", ...(id ? [id] : []), ...repoFlags])] : [],
          note: prog === "gh" ? "If your gh has no `pr revert`: git revert -m 1 <merge commit> on the base branch, then open a PR. The PR as it was before merging is saved in the checkpoint." : "Use the Revert button on the merge request, or git revert -m 1 <merge commit>.",
        },
      });
    }
    if (readActions.has(action) || action === "checkout") return READ;
    const n = ctx.seq.n++;
    if (action === "create" || action === "new")
      return make(ctx, "forge.pr.write", `opens a ${group === "pr" ? "pull request" : "merge request"}`, { undo: { summary: "Close it again", steps: [], note: `${prog} ${group} close <number> — the number is in the command's output.` } });
    return make(ctx, "forge.pr.write", `${action}s a ${group === "pr" ? "pull request" : "merge request"}`, { seq: n });
  }
  if (group === "issue") return readActions.has(action) ? READ : make(ctx, "forge.issue.write", `${action}s an issue`);
  if (group === "workflow" || group === "run" || group === "ci" || group === "pipeline") {
    if (readActions.has(action) || action === "view-log") return READ;
    const starting = ["run", "trigger", "rerun", "retry", "enable", "create"].includes(action);
    if (starting && (hasProdWord(ctx.policy, whole) || hasRiskyName(ctx.policy, whole))) return make(ctx, "forge.pipeline.run.prod", `starts a pipeline that looks like a deploy or release: ${whole}`);
    return make(ctx, "forge.pipeline.run", `${action}s a pipeline`, { undo: { summary: "Cancel the run", steps: [], note: `${prog} ${group === "ci" || group === "pipeline" ? "ci cancel" : "run cancel"} <run id> stops it; what it already did stays done.` } });
  }
  if (group === "release") return readActions.has(action) ? READ : make(ctx, "forge.release", `${action}s a release`);
  if (group === "repo" || group === "project") {
    if (["delete", "archive", "unarchive", "rename", "edit", "transfer"].includes(action)) return make(ctx, "forge.repo.admin", `${action}s a repository`);
    return readActions.has(action) || ["clone", "fork", "sync", "set-default"].includes(action) ? READ : make(ctx, "forge.api.write", `${group} ${action}`);
  }
  if (group === "secret" || group === "variable") return readActions.has(action) ? READ : make(ctx, "forge.secret", `${action}s a repository ${group}`);
  if (group === "auth") return ["status", "token"].includes(action) ? (action === "token" ? make(ctx, "forge.auth", "prints a credential") : READ) : make(ctx, "forge.auth", `${prog} auth ${action}`);
  if (group === "api") {
    const method = String(opts.get("X") ?? opts.get("method") ?? (multi.has("f") || multi.has("F") || multi.has("field") || multi.has("raw-field") || opts.has("input") ? "POST" : "GET")).toUpperCase();
    if (method === "GET") return READ;
    if (method === "DELETE") return make(ctx, "forge.api.delete", `DELETE ${action ?? ""} through the API`);
    return make(ctx, "forge.api.write", `${method} ${action ?? ""} through the API`);
  }
  if (["gist", "label", "ruleset", "codespace", "cache", "deploy-key", "ssh-key", "gpg-key", "environment"].includes(group)) return readActions.has(action) ? READ : make(ctx, group === "gist" || group === "label" || group === "cache" ? "forge.api.write" : "forge.repo.admin", `${group} ${action}`);
  return READ;
}

// ---- kubectl

const KUBE_VALUED = ["-n", "--namespace", "--context", "--cluster", "--user", "--kubeconfig", "-f", "--filename", "-k", "--kustomize", "-l", "--selector", "-o", "--output", "--replicas", "--image", "--type", "-p", "--patch", "--patch-file", "--field-selector", "--as", "--as-group", "-s", "--server", "--token", "--timeout", "--grace-period", "--cascade", "--field-manager", "--from-literal", "--from-file", "--from-env-file", "-c", "--container", "--tail", "--since", "--to-revision", "--overrides", "--port", "--target-port", "--name", "--min", "--max", "--cpu-percent", "--request-timeout", "--subresource", "--restart", "--env", "--labels", "--serviceaccount", "--pod-running-timeout", "--prune-allowlist"];
const KUBE_READ = new Set(["get", "describe", "logs", "log", "top", "explain", "api-resources", "api-versions", "version", "cluster-info", "diff", "wait", "events", "port-forward", "proxy", "completion", "kustomize", "auth", "plugin", "options", "help", "attach"]);
const KUBE_WIDE = new Set(["namespace", "namespaces", "ns", "node", "nodes", "no", "persistentvolume", "persistentvolumes", "pv", "persistentvolumeclaim", "persistentvolumeclaims", "pvc", "customresourcedefinition", "customresourcedefinitions", "crd", "crds", "clusterrole", "clusterroles", "clusterrolebinding", "clusterrolebindings", "storageclass", "storageclasses", "sc"]);

function kubectl(argv, ctx) {
  const prog = argv[0];
  const { pos, opts, multi } = parseArgs(argv.slice(1), KUBE_VALUED);
  const verb = pos[0];
  if (!verb) return READ;
  const sub = pos[1];
  const dry = opts.has("dry-run") && opts.get("dry-run") !== "none";
  if (KUBE_READ.has(verb) || dry || opts.has("help") || opts.has("h")) return READ;
  if (verb === "rollout" && ["status", "history"].includes(sub)) return READ;
  if (verb === "config") return ["view", "get-contexts", "current-context", "get-clusters", "get-users"].includes(sub) ? READ : make(ctx, "kube.config", `kubectl config ${sub} changes which cluster later commands talk to`);
  if (verb === "certificate" || verb === "apply" && sub === "view-last-applied") return verb === "apply" ? READ : make(ctx, "kube.change", `kubectl certificate ${sub}`);

  const kubeconfig = opts.get("kubeconfig") ?? null;
  const context = opts.get("context") ?? ctx.lookup.kubeContext(ctx.env ?? {}, kubeconfig);
  const ns = opts.get("n") ?? opts.get("namespace") ?? null;
  const zone = kubeZone(ctx.policy, context, ns);
  const where = `${context ? `context ${context}` : "the current context"}${ns ? `, namespace ${ns}` : ""}`;
  const base = [prog, ...(kubeconfig ? ["--kubeconfig", kubeconfig] : []), ...(context ? ["--context", context] : []), ...(ns ? ["-n", ns] : [])];
  const files = [...(multi.get("f") ?? multi.get("filename") ?? []).flatMap((f) => ["-f", f]), ...(multi.get("k") ?? multi.get("kustomize") ?? []).flatMap((k) => ["-k", k])];
  const all = opts.has("all") || opts.has("A") || opts.has("all-namespaces");
  const n = ctx.seq.n++;
  const snapshot = (target) => ({ name: `${n}-before.json`, argv: [...base, "get", ...target, "-o", "json", "--ignore-not-found"], sanitize: "k8s" });
  const restore = (summary, note) => ({ summary, steps: [`${sh([...base, "apply", "-f"])} {dir}/${n}-before.json`], note });
  const change = (why, extra) => make(ctx, zone === "prod" ? "kube.change.prod" : "kube.change", `${why} in ${where}`, extra);

  if (verb === "drain") return make(ctx, "kube.drain", `drains node ${sub ?? ""} in ${where}`);
  if (verb === "exec" || verb === "cp" || verb === "debug") return make(ctx, zone === "prod" ? "kube.exec.prod" : "kube.exec", `kubectl ${verb} in ${where}`);

  if (verb === "delete") {
    const targets = pos.slice(1);
    const kinds = targets.map((t) => t.split("/")[0].toLowerCase().split(".")[0]);
    if (all || (targets.length && KUBE_WIDE.has(kinds[0])) || kinds.some((k) => k.includes(",") && k.split(",").some((x) => KUBE_WIDE.has(x))))
      return make(ctx, "kube.delete.wide", `deletes ${all ? "everything matching, across the selection" : targets.join(" ")} in ${where}`);
    const target = files.length ? files : targets;
    return change(`deletes ${target.join(" ") || "resources"}`, { capture: [snapshot(target)], undo: restore("Recreate what was deleted from the saved manifests", "Recreated objects are new: pods restart, and data in deleted volumes does not come back.") });
  }
  if (verb === "apply" || verb === "replace") {
    if (!files.length) return change(`kubectl ${verb}`);
    return change(`applies ${files.filter((f) => !f.startsWith("-")).join(", ")}`, {
      capture: [snapshot(files)],
      undo: { ...restore("Re-apply the manifests as they were before", `Objects this ${verb} created are not in the checkpoint; remove them with: ${sh([...base, "delete", ...files])}`), ifEmpty: { file: `${n}-before.json`, summary: "Nothing existed before: delete what was created", steps: [sh([...base, "delete", ...files])] } },
    });
  }
  if (verb === "create" || verb === "run" || verb === "expose" || verb === "autoscale") {
    if (files.length) return change(`creates resources from ${files.filter((f) => !f.startsWith("-")).join(", ")}`, { undo: { summary: "Delete what was created", steps: [sh([...base, "delete", ...files])] } });
    const kind = verb === "create" ? pos[1] : verb === "run" ? "pod" : verb === "expose" ? "service" : "hpa";
    const name = verb === "create" ? pos[2] : verb === "run" ? pos[1] : opts.get("name") ?? pos[2] ?? pos[1];
    return change(`creates ${kind} ${name ?? ""}`.trim(), name && kind ? { undo: { summary: "Delete what was created", steps: [sh([...base, "delete", kind === "secret" ? "secret" : kind, name])] } } : {});
  }
  if (verb === "scale") {
    const target = files.length ? files : pos.slice(1);
    return change(`scales ${target.join(" ")} to ${opts.get("replicas") ?? "?"} replicas`, {
      capture: [{ name: `${n}-replicas.txt`, argv: [...base, "get", ...target, "-o", "jsonpath={.spec.replicas}"] }],
      undo: { summary: "Scale back to the previous replica count", steps: [`${sh([...base, "scale", ...target])} --replicas={@${n}-replicas.txt}`] },
    });
  }
  // set image, patch, label, annotate, edit, rollout restart|undo|pause|resume, taint, cordon…
  let target = pos.slice(1);
  if (verb === "set" || verb === "rollout") target = pos.slice(2);
  target = target.filter((t) => !/[=]/.test(t) && !/-$/.test(t));
  if (verb === "patch" || verb === "label" || verb === "annotate" || verb === "edit" || verb === "taint") target = target.slice(0, target[0]?.includes("/") ? 1 : 2);
  if (files.length) target = files;
  const workload = /^(deploy|deployment|deployments|sts|statefulset|statefulsets|ds|daemonset|daemonsets)(\.|\/|$)/i.test(target[0] ?? "");
  const label = `${verb}${verb === "set" || verb === "rollout" ? ` ${sub}` : ""}`;
  if (!target.length) return change(`kubectl ${label}`);
  return change(`${label} on ${target.join(" ")}`, {
    capture: [snapshot(target)],
    undo: restore("Re-apply the object as it was before", workload ? `For a workload, this also works: ${sh([...base, "rollout", "undo", ...target])}` : undefined),
  });
}

// ---- helm

const HELM_VALUED = ["-n", "--namespace", "--kube-context", "--kubeconfig", "-f", "--values", "--set", "--set-string", "--set-file", "--set-json", "--version", "--timeout", "--repo", "-o", "--output", "--revision", "--max", "--description", "--history-max", "--post-renderer", "--username", "--password", "--ca-file", "--cert-file", "--key-file", "-l", "--selector"];
const HELM_READ = new Set(["list", "ls", "status", "get", "history", "hist", "template", "lint", "show", "inspect", "search", "version", "env", "dependency", "dep", "plugin", "repo", "verify", "completion", "diff", "pull", "fetch", "package", "create", "help"]);

function helm(argv, ctx) {
  const { pos, opts } = parseArgs(argv.slice(1), HELM_VALUED);
  const verb = pos[0];
  if (!verb || HELM_READ.has(verb) || opts.has("dry-run") || opts.has("help")) return READ;
  if (verb === "push" || (verb === "registry" && pos[1] === "login")) return verb === "push" ? make(ctx, "publish.package", `pushes chart ${pos[1] ?? ""} to a registry`) : READ;
  const kubeconfig = opts.get("kubeconfig") ?? null;
  const context = opts.get("kube-context") ?? ctx.lookup.kubeContext(ctx.env ?? {}, kubeconfig);
  const ns = opts.get("n") ?? opts.get("namespace") ?? null;
  const prod = kubeZone(ctx.policy, context, ns) === "prod";
  const release = verb === "uninstall" || verb === "delete" || verb === "del" || verb === "un" ? pos.slice(1).join(" ") : pos[1];
  const base = ["helm", ...(kubeconfig ? ["--kubeconfig", kubeconfig] : []), ...(context ? ["--kube-context", context] : []), ...(ns ? ["-n", ns] : [])];
  const where = `${context ? `context ${context}` : "the current context"}${ns ? `, namespace ${ns}` : ""}`;
  const n = ctx.seq.n++;
  const rule = prod ? "helm.change.prod" : "helm.change";
  if (["upgrade", "rollback"].includes(verb))
    return make(ctx, rule, `helm ${verb} ${release ?? ""} in ${where}`, {
      capture: [{ name: `${n}-revision.txt`, argv: [...base, "history", release ?? "", "--max", "1", "-o", "json"], sanitize: "helmrev" }],
      undo: { summary: "Roll the release back to the revision it was on", steps: [`${sh([...base, "rollback", release ?? ""])} {@${n}-revision.txt}`], ifEmpty: { file: `${n}-revision.txt`, summary: "The release did not exist before: uninstall it", steps: [sh([...base, "uninstall", release ?? ""])] } },
    });
  if (verb === "install") return make(ctx, rule, `helm install ${release ?? ""} in ${where}`, { undo: { summary: "Uninstall the release", steps: [sh([...base, "uninstall", release ?? ""])] } });
  if (["uninstall", "delete", "del", "un"].includes(verb))
    return make(ctx, rule, `helm uninstall ${release} in ${where}`, {
      capture: pos.slice(1).flatMap((r, i) => [
        { name: `${n}-${i}-values.yaml`, argv: [...base, "get", "values", r, "-o", "yaml"] },
        { name: `${n}-${i}-manifest.yaml`, argv: [...base, "get", "manifest", r] },
      ]),
      undo: { summary: "Reinstall the release", steps: [], note: "Helm cannot roll back an uninstall. The release's values and manifest were saved in the checkpoint: reinstall the chart with those values." },
    });
  return make(ctx, rule, `helm ${verb} in ${where}`);
}

// ---- infrastructure as code

function iac(argv, ctx) {
  const prog = baseName(argv[0]);
  const { pos, opts } = parseArgs(argv.slice(1), ["-var", "-var-file", "-target", "-chdir", "--stack", "-s", "--cwd", "-C", "--app", "--profile"]);
  const verb = pos[0];
  const readVerbs = new Set(["plan", "validate", "fmt", "show", "output", "init", "providers", "graph", "version", "get", "console", "login", "logout", "preview", "diff", "synth", "synthesize", "list", "ls", "doctor", "docs", "metadata", "whoami", "about", "config", "help", "test", "stack", "render-json", "hclfmt", "bootstrap", "context", "acknowledge", "notices", "plugin", "schema"]);
  if (!verb || opts.has("help")) return READ;
  if (verb === "state" || verb === "force-unlock") return ["list", "show", "pull"].includes(pos[1]) ? READ : make(ctx, "iac.state", `${prog} ${verb} ${pos[1] ?? ""} edits infrastructure state`.trim());
  if (verb === "workspace") return ["delete"].includes(pos[1]) ? make(ctx, "iac.state", `${prog} workspace delete`) : READ;
  if (verb === "stack" && ["rm", "remove"].includes(pos[1])) return make(ctx, "iac.state", `${prog} stack rm`);
  if (readVerbs.has(verb)) return READ;
  if (["apply", "destroy", "import", "taint", "untaint", "up", "update", "refresh", "deploy", "run-all", "cancel", "replace", "watch"].includes(verb)) return make(ctx, "iac.apply", `${prog} ${verb} changes real infrastructure`);
  return {};
}

// ---- cloud CLIs, read by their verbs

const CLOUD_DESTROY = /^(delete|terminate|destroy|remove|rm|rb|purge|drop|deregister|revoke|detach|release|decommission|wipe|uninstall|nuke)([-_:].*)?$|^(delete|terminate|destroy|remove|purge|deregister|revoke)-/i;
const CLOUD_READ = /^(describe|list|get|show|ls|log|logs|tail|status|whoami|info|view|check|validate|help|version|diff|preview|search|lookup|wait|export|configure|login|auth|print|read|head|cat|history|top|doctor|open|browse|inspect|whoami|presign|query|scan|select|estimate|simulate|test|verify|completion)([-_:].*)?$/i;

function cloud(argv, ctx) {
  const prog = baseName(argv[0]);
  const words = argv.slice(1).filter((a) => !a.startsWith("-"));
  const whole = argv.slice(1).join(" ");
  if (!words.length || argv.includes("--help") || argv.includes("help")) return READ;
  if (prog === "aws" && words[0] === "s3" && ((words[1] === "sync" && argv.includes("--delete")) || words[1] === "rb" || (words[1] === "rm" && argv.includes("--recursive")))) return make(ctx, "cloud.delete", `aws s3 ${words[1]} removes objects in bulk`);
  if (prog === "aws" && words[0] === "sts") return READ;
  if (prog === "gcloud" && words.includes("get-credentials")) return make(ctx, "kube.config", "gcloud get-credentials changes which cluster later commands talk to");
  const verbs = words.slice(0, 4);
  const destroy = verbs.find((w) => CLOUD_DESTROY.test(w));
  if (destroy) return make(ctx, "cloud.delete", `${prog} ${verbs.join(" ")} deletes or terminates a resource`);
  if (verbs.some((w) => CLOUD_READ.test(w)) && !verbs.some((w) => /^(create|update|put|deploy|set|add|run|start|stop|apply|promote|publish|scale|restart|rollback|enable|disable|attach|modify|import|invoke|send|push|cp|mv|sync|mb)([-_:].*)?$/i.test(w))) return READ;
  const prod = hasProdWord(ctx.policy, whole) || argv.includes("--prod") || argv.includes("--production");
  return make(ctx, prod ? "cloud.change.prod" : "cloud.change", `${prog} ${verbs.join(" ")}${prod ? " targets production" : ""}`);
}

function gitops(argv, ctx) {
  const prog = baseName(argv[0]);
  const words = argv.slice(1).filter((a) => !a.startsWith("-"));
  const whole = argv.slice(1).join(" ");
  const verb = prog === "argocd" ? words[1] : words[0];
  if (!verb || ["get", "list", "diff", "history", "logs", "version", "login", "context", "manifests", "resources", "wait", "check", "export", "stats", "tree", "events", "trace", "help"].includes(verb)) return READ;
  if (["delete", "uninstall", "terminate-op"].includes(verb)) return make(ctx, "gitops.delete", `${prog} ${words.join(" ")}`);
  return make(ctx, hasProdWord(ctx.policy, whole) ? "gitops.sync.prod" : "gitops.sync", `${prog} ${words.join(" ")}`, prog === "argocd" && verb === "sync" ? { undo: { summary: "Roll the application back", steps: [], note: `argocd app history ${words[2] ?? "<app>"} lists revisions; argocd app rollback ${words[2] ?? "<app>"} <id> returns to one.` } } : {});
}

// ---- docker, package registries

function docker(argv, ctx) {
  const words = argv.slice(1).filter((a) => !a.startsWith("-"));
  const [a, b] = words;
  if (a === "push" || (a === "image" && b === "push") || (a === "buildx" && argv.includes("--push")) || (a === "compose" && b === "push")) return make(ctx, "docker.push", `pushes image ${words[words.length - 1] ?? ""}`);
  if ((a === "system" && b === "prune" && (argv.includes("--volumes") || argv.includes("-a") || argv.includes("--all"))) || (a === "volume" && ["rm", "prune", "remove"].includes(b)) || (a === "compose" && b === "down" && (argv.includes("-v") || argv.includes("--volumes"))))
    return make(ctx, "docker.prune", `docker ${a} ${b} deletes volumes, and the data in them`);
  return {};
}

function publishing(argv, ctx) {
  const prog = baseName(argv[0]);
  const words = argv.slice(1).filter((a) => !a.startsWith("-"));
  const dry = argv.some((a) => a.startsWith("--dry-run") || a === "--snapshot" || a === "-n" && prog === "cargo");
  if (dry) return null;
  const say = (what) => make(ctx, "publish.package", `${what} — published versions cannot be taken back`);
  if (["npm", "pnpm", "yarn", "bun"].includes(prog) && (["publish", "unpublish", "deprecate"].includes(words[0]) || (words[0] === "dist-tag" && ["add", "rm"].includes(words[1])) || (words[0] === "npm" && words[1] === "publish"))) return say(`${prog} ${words.slice(0, 2).join(" ")}`);
  if (prog === "cargo" && ["publish", "yank"].includes(words[0])) return say(`cargo ${words[0]}`);
  if (prog === "twine" && words[0] === "upload") return say("twine upload");
  if ((prog === "poetry" || prog === "uv" || prog === "hatch" || prog === "flit") && words[0] === "publish") return say(`${prog} publish`);
  if (prog === "gem" && ["push", "yank"].includes(words[0])) return say(`gem ${words[0]}`);
  if (prog === "dotnet" && words[0] === "nuget" && words[1] === "push") return say("dotnet nuget push");
  if (prog === "goreleaser" && (words[0] === "release" || !words.length)) return say("goreleaser release");
  if ((prog === "mvn" || prog === "mvnw") && words.includes("deploy")) return say("mvn deploy");
  if ((prog === "gradle" || prog === "gradlew") && words.some((w) => /^publish/.test(w) && !/ToMavenLocal$/.test(w))) return say("gradle publish");
  return null;
}

// ---- databases

const DB_PROGRAMS = new Set(["psql", "mysql", "mariadb", "sqlite3", "mongosh", "mongo", "redis-cli", "cqlsh", "clickhouse-client", "sqlcmd", "bq", "duckdb", "cockroach", "pg_restore", "mongorestore", "mysqladmin", "dropdb", "dropuser", "createdb"]);
const SQL_DESTROY = /\b(drop\s+(database|schema|table|index|view|role|user|collection|keyspace|materialized)|truncate\b|flushall|flushdb|dropdatabase\s*\(|\.drop\s*\(|deletemany\s*\(\s*\{\s*\}\s*\)|\.remove\s*\(\s*\{\s*\}\s*\))/i;
const SQL_WRITE = /\b(insert|update|delete|alter|create|grant|revoke|replace|merge|copy|vacuum|reindex|upsert|rename)\b|\.(insert|update|delete|replace|create|rename)\w*\s*\(|^\s*(set|del|hset|hdel|lpush|rpush|sadd|zadd|expire|incr|decr|mset|unlink|config\s+set)\b/i;

function database(argv, ctx, cmd) {
  const prog = baseName(argv[0]);
  const { pos, opts, multi } = parseArgs(argv.slice(1), ["-c", "--command", "-e", "--execute", "--eval", "-Q", "-q", "-f", "--file", "-h", "--host", "-p", "--port", "-U", "--username", "-u", "--user", "-d", "--dbname", "-D", "--database", "-n", "-a", "--password", "-i", "--input-file", "--uri"]);
  const whole = argv.slice(1).join(" ");
  const prod = hasProdWord(ctx.policy, whole) || envSaysProd(ctx, DB_ENV.slice(0, 9));
  if (["dropdb", "dropuser"].includes(prog) || (prog === "mysqladmin" && pos.includes("drop")) || ((prog === "pg_restore" || prog === "mongorestore") && (argv.includes("--clean") || argv.includes("-c") || argv.includes("--drop")))) return make(ctx, "db.destroy", `${prog} ${pos.join(" ")} drops existing data`);
  let sql = [...(multi.get("c") ?? []), ...(multi.get("command") ?? []), ...(multi.get("e") ?? []), ...(multi.get("execute") ?? []), ...(multi.get("eval") ?? []), ...(multi.get("Q") ?? []), ...(multi.get("q") ?? [])].join("; ");
  if (cmd?.stdin) sql += `; ${cmd.stdin}`;
  if (prog === "redis-cli" || prog === "bq") sql += `; ${pos.join(" ")}`;
  else if ((prog === "sqlite3" || prog === "duckdb") && pos.length > 1) sql += `; ${pos.slice(1).join(" ")}`;
  const file = opts.get("f") ?? opts.get("file") ?? opts.get("i") ?? opts.get("input-file") ?? (cmd?.redirects ?? []).find((r) => r.op === "<")?.target;
  if (SQL_DESTROY.test(sql) || (/\bdelete\s+from\b/i.test(sql) && !/\bwhere\b/i.test(sql)) || (prog === "bq" && /^\s*;?\s*rm\b/.test(sql))) return make(ctx, "db.destroy", `${prog}: ${sql.trim().replace(/^;\s*/, "").slice(0, 120)}`);
  if (SQL_WRITE.test(sql)) return make(ctx, prod ? "db.write.prod" : "db.write", `${prog} writes${prod ? " to a production database" : ""}: ${sql.trim().replace(/^;\s*/, "").slice(0, 120)}`);
  if (file) return make(ctx, prod ? "db.write.prod" : "db.write", `${prog} runs ${file}${prod ? " against a production database" : ""}, which Oui Chef has not read`);
  if (!sql.replace(/[;\s]/g, "")) return ["createdb", "pg_restore", "mongorestore"].includes(prog) ? make(ctx, prod ? "db.write.prod" : "db.write", `${prog} ${pos.join(" ")}`) : READ;
  return READ;
}

// Migration runners hide behind npx, bundle exec, python -m… so they are found by phrase.
const PHRASES = [
  [/\bprisma\s+migrate\s+reset\b|\bprisma\s+db\s+push\b.*--(force-reset|accept-data-loss)|\b(rails|rake)\b.*\bdb:(drop|reset|purge)\b|\bmanage\.py\s+(flush|sqlflush)\b|\bflyway\b.*\bclean\b|\bsequelize(-cli)?\s+db:drop\b|\bgoose\b.*\breset\b|\bliquibase\b.*\bdrop-?all\b|\bdbmate\s+drop\b|\bmigrate\b.*\s(drop|force)\b/i, "db.destroy", "resets or drops a database"],
  [/\bprisma\s+(migrate\s+(deploy|dev|resolve)|db\s+push)\b|\balembic\s+(upgrade|downgrade)\b|\b(rails|rake)\b.*\bdb:(migrate|rollback|seed|schema:load)\b|\bmanage\.py\s+migrate\b|\bflyway\b.*\b(migrate|repair|undo)\b|\bknex\s+migrate:(latest|up|down|rollback)\b|\bsequelize(-cli)?\s+db:migrate\b|\bgoose\b.*\b(up|down|redo)\b|\batlas\s+(migrate|schema)\s+apply\b|\bliquibase\b.*\b(update|rollback)\b|\bdbmate\s+(up|migrate|rollback|down)\b|\bdrizzle-kit\s+(push|migrate)\b|\btypeorm\s+migration:(run|revert)\b|\bdiesel\s+migration\s+(run|revert|redo)\b|\bsqlx\s+migrate\s+(run|revert)\b/i, "db.migrate", "runs database migrations"],
];

// ---- files and the machine

function rm(argv, ctx) {
  const { pos, opts } = parseArgs(argv.slice(1));
  const recursive = opts.has("r") || opts.has("R") || opts.has("recursive");
  const outside = [];
  for (const p of pos) {
    const abs = resolvePath(ctx, p);
    if (!inWorkspace(ctx, abs) || (recursive && isRootish(ctx, abs))) outside.push(p);
  }
  if (!outside.length) return {};
  return recursive ? make(ctx, "fs.rm.outside", `rm -r ${outside.join(" ")} is outside the cook's station`) : make(ctx, "fs.rm.file.outside", `deletes ${outside.join(" ")}, outside the cook's station`);
}

function findProgram(argv, ctx) {
  const firstExpr = argv.findIndex((a, i) => i > 0 && (a.startsWith("-") || a === "(" || a === "!"));
  const roots = (firstExpr < 0 ? argv.slice(1) : argv.slice(1, firstExpr)).filter((a) => !["-H", "-L", "-P"].includes(a));
  const hits = [];
  const exec = argv.findIndex((a) => ["-exec", "-execdir", "-ok"].includes(a));
  if (exec > 0) {
    const end = argv.findIndex((a, i) => i > exec && (a === ";" || a === "+"));
    hits.push({ inner: argv.slice(exec + 1, end < 0 ? undefined : end).filter((a) => a !== "{}") });
  }
  if (argv.includes("-delete") || hits.some((h) => baseName(h.inner?.[0]) === "rm")) {
    const outside = (roots.length ? roots : ["."]).filter((r) => {
      const abs = resolvePath(ctx, r);
      return !inWorkspace(ctx, abs) || isRootish(ctx, abs);
    });
    if (outside.length) return make(ctx, "fs.rm.outside", `find … -delete under ${outside.join(" ")}, outside the cook's station`);
    return {};
  }
  return hits.length ? { recurseArgv: hits.map((h) => h.inner) } : READ;
}

function perms(argv, ctx) {
  const { pos, opts } = parseArgs(argv.slice(1));
  if (!(opts.has("R") || opts.has("recursive"))) return {};
  const outside = pos.slice(1).filter((p) => {
    const abs = resolvePath(ctx, p);
    return !inWorkspace(ctx, abs) || isRootish(ctx, abs);
  });
  return outside.length ? make(ctx, "fs.perm.outside", `${baseName(argv[0])} -R on ${outside.join(" ")}, outside the cook's station`) : {};
}

function service(argv, ctx) {
  const words = argv.slice(1).filter((a) => !a.startsWith("-"));
  if (!words.length || ["status", "list", "list-units", "list-unit-files", "show", "is-active", "is-enabled", "cat", "print", "get-default", "list-timers", "help"].includes(words[0])) return READ;
  if (baseName(argv[0]) === "service" && words[1] === "status") return READ;
  return make(ctx, "sys.service", `${baseName(argv[0])} ${words.join(" ")}`);
}

function http(argv, ctx) {
  const prog = baseName(argv[0]);
  const { opts, multi, pos } = parseArgs(argv.slice(1), ["-X", "--request", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "-F", "--form", "-T", "--upload-file", "-H", "--header", "-o", "--output", "-u", "--user", "--json", "-A", "-e", "-b", "-c", "--connect-timeout", "-m", "--max-time", "--retry", "-w", "--method", "--body-data", "--post-data", "--post-file", "-O", "--cacert", "--cert", "--key", "-x", "--proxy", "--url", "-K"]);
  const explicit = opts.get("X") ?? opts.get("request") ?? opts.get("method");
  const sends = ["d", "data", "data-raw", "data-binary", "data-urlencode", "F", "form", "T", "upload-file", "json", "body-data", "post-data", "post-file"].some((k) => multi.has(k) || opts.has(k));
  const httpie = prog === "http" || prog === "https" || prog === "xh";
  const method = String(explicit ?? (httpie && /^(GET|POST|PUT|PATCH|DELETE|HEAD)$/i.test(pos[0] ?? "") ? pos[0] : sends ? "POST" : "GET")).toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return READ;
  const url = pos.find((p) => /^https?:|^[\w.-]+\.[a-z]{2,}(\/|:|$)|^localhost|^\d+\.\d+/.test(p)) ?? opts.get("url") ?? "";
  let hostName = url;
  try {
    hostName = new URL(/^https?:/.test(url) ? url : `http://${url}`).host;
  } catch {}
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(hostName)) return {};
  const prod = hasProdWord(ctx.policy, hostName) || matchesAny(ctx.policy.prod?.hosts, hostName.split(":")[0]);
  return make(ctx, prod ? "net.http.write.prod" : "net.http.write", `${method} ${url.slice(0, 100)}`);
}

function opaque(what, name, ctx) {
  return hasRiskyName(ctx.policy, name) ? make(ctx, "script.risky", `runs ${what}; Oui Chef cannot see what it does and its name suggests a deploy or a destructive step`) : null;
}

function taskRunner(argv, ctx) {
  const prog = baseName(argv[0]);
  const words = argv.slice(1).filter((a) => !a.startsWith("-") && !/=/.test(a));
  let names = [];
  if (prog === "make" || prog === "gmake" || prog === "just" || prog === "task" || prog === "rake" || prog === "mage" || prog === "invoke" || prog === "nx" || prog === "turbo" || prog === "tox" || prog === "nox") names = words;
  else if (["npm", "pnpm", "yarn", "bun"].includes(prog)) {
    if (words[0] === "run" || words[0] === "run-script") names = words.slice(1, 2);
    else if (prog !== "npm" && words[0] && !["install", "add", "remove", "i", "ci", "test", "build", "exec", "dlx", "x", "create", "init", "link", "update", "upgrade", "why", "list", "ls", "outdated", "audit", "pack", "publish", "config", "cache", "store", "import", "info", "view", "login", "logout", "whoami", "version", "dev", "start", "lint", "format", "typecheck", "pm", "workspaces", "workspace"].includes(words[0])) names = words.slice(0, 1);
  }
  for (const name of names) {
    const hit = opaque(`${prog} ${argv.slice(1).join(" ")}`.trim(), name, ctx);
    if (hit) return hit;
  }
  return {};
}

function ssh(argv, ctx) {
  const prog = baseName(argv[0]);
  if (prog !== "ssh") {
    const whole = argv.slice(1).join(" ");
    const remote = argv.slice(1).find((a) => /^[\w.-]+@?[\w.-]*:/.test(a) && !/^[a-zA-Z]:\\/.test(a));
    if (!remote) return {};
    const hostName = remote.split(":")[0].split("@").pop();
    const prod = hasProdWord(ctx.policy, hostName) || matchesAny(ctx.policy.prod?.hosts, hostName);
    const deletes = /--delete|--remove-source-files/.test(whole);
    return prod || deletes ? make(ctx, prod ? "ssh.remote.prod" : "ssh.remote", `${prog} to ${hostName}${deletes ? " with deletion" : ""}`) : {};
  }
  const { pos } = parseArgs(argv.slice(1), ["-p", "-i", "-l", "-o", "-F", "-J", "-L", "-R", "-D", "-b", "-c", "-e", "-m", "-E", "-S", "-W", "-w", "-B", "-I", "-Q"]);
  const hostName = (pos[0] ?? "").split("@").pop();
  const remote = pos.slice(1).join(" ");
  if (!remote) return READ;
  return { recurseRemote: remote, host: hostName };
}

const PROGRAMS = {
  git,
  gh: forge,
  glab: forge,
  kubectl,
  k: kubectl,
  oc: kubectl,
  kubecolor: kubectl,
  helm,
  helmfile: (argv, ctx) => (["apply", "sync", "destroy", "delete"].some((v) => argv.includes(v)) ? make(ctx, hasProdWord(ctx.policy, argv.join(" ")) ? "helm.change.prod" : "helm.change", argv.join(" ")) : READ),
  terraform: iac,
  tofu: iac,
  terragrunt: iac,
  pulumi: iac,
  cdk: iac,
  cdktf: iac,
  aws: cloud,
  gcloud: cloud,
  az: cloud,
  doctl: cloud,
  flyctl: cloud,
  fly: cloud,
  vercel: cloud,
  netlify: cloud,
  heroku: cloud,
  railway: cloud,
  wrangler: cloud,
  supabase: cloud,
  firebase: cloud,
  linode: cloud,
  hcloud: cloud,
  gsutil: cloud,
  argocd: gitops,
  flux: gitops,
  docker,
  podman: docker,
  nerdctl: docker,
  rm,
  rmdir: rm,
  unlink: rm,
  find: findProgram,
  chmod: perms,
  chown: perms,
  chgrp: perms,
  dd: (argv, ctx) => (argv.some((a) => /^of=\/dev\//.test(a)) ? make(ctx, "fs.disk", `dd writes to ${argv.find((a) => a.startsWith("of="))}`) : {}),
  mkfs: (argv, ctx) => make(ctx, "fs.disk", `${baseName(argv[0])} formats a device`),
  shred: (argv, ctx) => make(ctx, "fs.disk", "shred destroys file contents"),
  wipefs: (argv, ctx) => make(ctx, "fs.disk", "wipefs erases a device"),
  fdisk: (argv, ctx) => (argv.includes("-l") ? READ : make(ctx, "fs.disk", "fdisk edits partitions")),
  parted: (argv, ctx) => make(ctx, "fs.disk", "parted edits partitions"),
  diskutil: (argv, ctx) => (/^(list|info|activity)$/.test(argv[1] ?? "") ? READ : make(ctx, "fs.disk", `diskutil ${argv[1]}`)),
  systemctl: service,
  service,
  launchctl: service,
  shutdown: (argv, ctx) => make(ctx, "sys.power", "shuts the machine down"),
  reboot: (argv, ctx) => make(ctx, "sys.power", "reboots the machine"),
  halt: (argv, ctx) => make(ctx, "sys.power", "halts the machine"),
  poweroff: (argv, ctx) => make(ctx, "sys.power", "powers the machine off"),
  curl: http,
  wget: http,
  http,
  https: http,
  xh: http,
  ssh,
  scp: ssh,
  rsync: ssh,
  sftp: ssh,
  make: taskRunner,
  gmake: taskRunner,
  just: taskRunner,
  task: taskRunner,
  rake: taskRunner,
  mage: taskRunner,
  npm: taskRunner,
  pnpm: taskRunner,
  yarn: taskRunner,
  bun: taskRunner,
  nx: taskRunner,
  turbo: taskRunner,
};
for (const p of DB_PROGRAMS) PROGRAMS[p] = database;
for (const p of ["mkfs.ext4", "mkfs.xfs", "mkfs.vfat", "mkfs.btrfs"]) PROGRAMS[p] = PROGRAMS.mkfs;

// ---- Oui Chef's own controls

// Oui Chef's own control files, relative to its home: the chef's token, the
// policy, the state, the hook settings that keep the guard in place, and the chef's
// own prompts, which are what every agent is told. Worktrees also live under the
// home, so this names exact files rather than anything "*.json".
const CONTROL = String.raw`(?:daemon\.json|policy\.json|state\.json|config\.json|ledger\.jsonl|events\.jsonl|bin/oui|(?:tickets|roles)/[^/\s'"]+/settings\.json|prompts/[^/\s'"]+)`;
const CONTROL_REL = new RegExp(`^${CONTROL}$`);
const CONTROL_BARE = /(^|[\s'"=])(daemon\.json|policy\.json|state\.json|ledger\.jsonl)(?=$|[\s'";|&)])/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function isControlPath(ctx, abs) {
  if (!ctx.home || !abs) return false;
  const root = real(ctx.home);
  const where = real(abs);
  return within(root, where) && CONTROL_REL.test(path.relative(root, where).split(path.sep).join("/"));
}

function tamper(text, ctx) {
  if (!ctx.role || ctx.role === "chef") return null;
  const deny = (why) => make(ctx, "oui.tamper", why);
  // The home, however it is spelled: its real path, $OUI_HOME, or the default under ~.
  const homes = [...(ctx.home ? [...new Set([path.resolve(ctx.home), real(ctx.home)])].map(escapeRe) : []), String.raw`\$\{?OUI_HOME\}?`, String.raw`(?:~|\$\{?HOME\}?)/\.ouichef`].join("|");
  if (new RegExp(`(?:${homes})/+${CONTROL}(?=$|[\\s'";|&)<>])`).test(text)) return deny("touches Oui Chef's control files");
  if (new RegExp(`\\b(?:cd|pushd)\\s+["']?(?:${homes})/?["']?(?=$|[\\s;&|])`).test(text) && CONTROL_BARE.test(text)) return deny("touches Oui Chef's control files");
  if (new RegExp(`\\b(?:cd|pushd)\\s+["']?(?:${homes})/+prompts(?=$|[/\\s'";&|])`).test(text)) return deny("goes into the folder that holds what every agent is told");
  if (ctx.port && new RegExp(`(127\\.0\\.0\\.1|localhost|\\[::1\\]|0\\.0\\.0\\.0):${ctx.port}\\b`).test(text)) return deny("talks to the Oui Chef daemon directly instead of through oui");
  if (/\bOUI_(TOKEN|ROLE|TASK|HOME|RUN|ROOTS|PROTECTED|PORT)\s*=|\bunset\s+OUI_|\bexport\s+OUI_/.test(text)) return deny("changes the identity Oui Chef gave this agent");
  return null;
}

function ownCli(argv, ctx) {
  const role = ctx.role;
  if (!role || role === "chef") return READ;
  const { pos } = parseArgs(argv.slice(1));
  const verb = pos[0] ?? "help";
  if ((ROLE_VERBS[role] ?? []).includes(verb)) return READ;
  return make(ctx, "oui.tamper", `oui ${verb} is the chef's command; as ${role} you may use: ${(ROLE_VERBS[role] ?? []).join(", ")}`);
}

// ---- putting it together

function classifyOne(cmd, next, ctx, out, depth) {
  const u = unwrap(cmd.argv);
  if (!u.argv.length) return "read";
  const prog = baseName(u.argv[0]);
  const local = { ...ctx, env: { ...ctx.env, ...u.env } };
  let res = null;

  const isOui = prog === "oui" || prog === "oui.mjs" || (prog === "node" && /(^|\/)oui\.mjs$/.test(u.argv[1] ?? ""));
  if (isOui) res = ownCli(prog === "node" ? u.argv.slice(1) : u.argv, local);
  else if (AGENTS.has(prog) && ctx.role && ctx.role !== "chef") res = make(local, "agent.nested", `starts ${prog}, which would run without Oui Chef's guard. Use your own subagents instead`);
  else if (SHELLS.has(prog) || prog === "eval") {
    const c = prog === "eval" ? u.argv.slice(1).join(" ") : u.argv[u.argv.indexOf("-c") + 1];
    const inline = prog === "eval" || u.argv.includes("-c") ? c : null;
    if (inline) walk(inline, local, out, depth + 1);
    else if (cmd.stdin) walk(cmd.stdin, local, out, depth + 1);
    const script = u.argv.slice(1).find((a) => !a.startsWith("-"));
    res = !inline && script ? opaque(`${prog} ${script}`, baseName(script), local) ?? {} : {};
  } else if (prog === "xargs" || prog === "parallel") {
    const inner = u.argv.slice(1).filter((a, i, all) => !(a.startsWith("-") || ["-I", "-n", "-P", "-L", "-d", "-s", "-E", "-j"].includes(all[i - 1])));
    if (inner.length) return classifyOne({ argv: inner, redirects: [], stdin: null }, null, local, out, depth + 1) === "read" ? "read" : "change";
    res = READ;
  } else if (PROGRAMS[prog]) res = PROGRAMS[prog](u.argv, local, cmd);
  else if (INTERPRETERS.has(prog) || /\.(sh|bash|zsh|py|rb|pl|js|mjs|ts)$/.test(prog) || u.argv[0].startsWith("./") || u.argv[0].startsWith("../")) {
    const script = INTERPRETERS.has(prog) ? u.argv.slice(1).find((a) => !a.startsWith("-")) : u.argv[0];
    res = (script && opaque(u.argv.join(" ").slice(0, 80), baseName(script), local)) ?? {};
  } else if (READERS.has(prog)) res = prog === "awk" && /system\s*\(/.test(u.argv.join(" ")) ? {} : READ;
  else if (prog === "sed") res = u.argv.some((a) => /^-[a-zA-Z]*i/.test(a) || a === "--in-place") ? {} : READ;
  else if (prog === "tee") res = {};

  res = res ?? {};
  const whole = u.argv.join(" ");
  if (res.recurseArgv) {
    let all = "read";
    for (const inner of res.recurseArgv) if (classifyOne({ argv: inner, redirects: [], stdin: null }, null, local, out, depth + 1) !== "read") all = "change";
    res = all === "read" ? READ : {};
  }
  if (res.recurseRemote) {
    const inner = [];
    const kind = walk(res.recurseRemote, { ...local, roots: [], cwd: "/", role: ctx.role }, inner, depth + 1);
    const prod = hasProdWord(ctx.policy, res.host) || matchesAny(ctx.policy.prod?.hosts, res.host);
    out.push(...inner.map((h) => ({ ...h, why: `on ${res.host}: ${h.why}`, capture: undefined, undo: undefined })));
    if (kind !== "read") out.push(make(local, prod ? "ssh.remote.prod" : "ssh.remote", `runs \`${res.recurseRemote.slice(0, 100)}\` on ${res.host}`));
    return kind === "read" ? "read" : "change";
  }

  const publish = publishing(u.argv, local);
  if (publish) res = publish;
  for (const [re, rule, why] of PHRASES) {
    if (!re.test(whole)) continue;
    const prod = hasProdWord(ctx.policy, whole) || envSaysProd(local, DB_ENV);
    res = make(local, rule === "db.migrate" && prod ? "db.migrate.prod" : rule, `${whole.slice(0, 90)} ${why}${prod && rule === "db.migrate" ? " against production" : ""}`);
    break;
  }
  if (res.rule) out.push({ ...res, command: sh(cmd.argv) });
  // `echo x > ~/.zshrc` writes outside the station as surely as an editor would.
  for (const r of cmd.redirects ?? []) {
    if (r.op !== ">" && r.op !== ">>") continue;
    if (r.target.startsWith("&") || r.target.startsWith("/dev/")) continue;
    const abs = resolvePath(local, r.target);
    if (abs && isControlPath(ctx, abs) && ctx.role && ctx.role !== "chef") out.push({ ...make(local, "oui.tamper", "writes one of Oui Chef's control files"), command: `${sh(cmd.argv)} ${r.op} ${r.target}` });
    else if (abs && !inWorkspace(local, abs)) out.push({ ...make(local, "fs.write.outside", `writes ${abs}, outside the cook's station`), command: `${sh(cmd.argv)} ${r.op} ${r.target}` });
  }
  if (prog === "tee") {
    const outside = u.argv.slice(1).filter((a) => !a.startsWith("-")).map((a) => resolvePath(local, a)).filter((abs) => abs && !abs.startsWith("/dev/") && !inWorkspace(local, abs));
    if (outside.length) out.push({ ...make(local, "fs.write.outside", `tee writes ${outside.join(", ")}, outside the cook's station`), command: sh(cmd.argv) });
  }

  const wrote = out.length && (cmd.redirects ?? []).some((r) => r.op === ">" || r.op === ">>") && out.at(-1).rule === "fs.write.outside";
  const kind = res.rule || wrote ? "change" : res.read ? "read" : "unknown";
  if (u.privileged && kind === "unknown") out.push({ ...make(local, "sys.sudo", `runs \`${whole.slice(0, 100)}\` as root`), command: sh(cmd.argv) });
  if (next && ["curl", "wget", "fetch"].includes(prog)) {
    const consumer = baseName(unwrap(next.argv).argv[0]);
    if (SHELLS.has(consumer) || INTERPRETERS.has(consumer)) out.push({ ...make(local, "net.pipe.shell", `pipes a download from ${whole.slice(0, 80)} straight into ${consumer}`), command: `${sh(cmd.argv)} | ${sh(next.argv)}` });
  }
  return kind;
}

// Returns "read" when every command in `text` is a recognised read-only one.
function walk(text, ctx, out, depth) {
  if (depth > 5) return "unknown";
  const { commands, subs } = parseShell(text);
  let all = "read";
  commands.forEach((cmd, i) => {
    const kind = classifyOne(cmd, cmd.sep === "|" ? commands[i + 1] : null, ctx, out, depth);
    if (kind !== "read") all = kind === "change" || all === "change" ? "change" : "unknown";
  });
  for (const s of subs) if (walk(s, ctx, out, depth + 1) !== "read") all = all === "read" ? "unknown" : all;
  return all;
}

function withContext(ctx) {
  const full = { cwd: process.cwd(), env: {}, roots: [], role: null, lookup: defaultLookup, protectedBranches: [], ...ctx, seq: { n: 0 } };
  return { ...full, cwd: real(full.cwd), roots: (full.roots ?? []).filter(Boolean).map(real) };
}

function settle(hits, ctx, command) {
  const policy = ctx.policy;
  let forced = null;
  if (command != null) {
    if (matchesAny(policy.deny, command)) forced = { tier: 3, rule: "policy.deny", about: "Matches a deny pattern in your policy", why: "your policy.json denies this command" };
    else if (matchesAny(policy.hold, command)) forced = { tier: 2, rule: "policy.hold", about: "Matches a hold pattern in your policy", why: "your policy.json holds this command for approval" };
    else if (matchesAny(policy.allow, command) && !hits.some((h) => h.tier === 3)) {
      const kept = hits.filter((h) => h.tier >= 1).map((h) => ({ ...h, tier: 1 }));
      hits = kept.length ? kept : [];
    }
  }
  if (forced) hits = [forced, ...hits];
  const top = hits.reduce((best, h) => (!best || h.tier > best.tier ? h : best), null);
  const recorded = hits.filter((h) => h.tier >= 1);
  return {
    tier: top?.tier ?? 0,
    rule: top?.rule ?? null,
    about: top?.about ?? null,
    why: top?.why ?? null,
    hits: recorded.map(({ capture, undo, ...h }) => h),
    capture: recorded.flatMap((h) => h.capture ?? []),
    undo: recorded.filter((h) => h.undo).map((h) => ({ ...h.undo, for: h.command ?? null })),
  };
}

export function classify(command, context) {
  const ctx = withContext(context);
  const hits = [];
  const t = tamper(command, ctx);
  if (t) hits.push({ ...t, command });
  walk(command, ctx, hits, 0);
  return settle(hits, ctx, command);
}

const WRITERS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// Any tool call, not just Bash. Reading is free; writing outside the station is held.
export function classifyTool(tool, input, context) {
  if (tool === "Bash") return classify(String(input?.command ?? ""), context);
  const ctx = withContext(context);
  const file = input?.file_path ?? input?.notebook_path ?? input?.path ?? null;
  const hits = [];
  // Connected tools can post, send and delete. Ones that plainly only look are free; the rest are recorded.
  if (/^mcp__/.test(tool) && ctx.role && ctx.role !== "chef") {
    const name = tool.split("__").pop() ?? "";
    if (!/^(get|list|search|read|fetch|view|query|find|describe|show|lookup|check|count|status|whoami|resolve|browse|inspect|preview)([_A-Z-]|$)/i.test(name)) hits.push(make(ctx, "mcp.call", `calls ${tool}`));
  }
  if (file && ctx.role && ctx.role !== "chef") {
    const abs = real(path.resolve(ctx.cwd, String(file)));
    if (isControlPath(ctx, abs)) hits.push(make(ctx, "oui.tamper", `${WRITERS.has(tool) ? "writes" : "reads"} ${path.basename(abs)}, one of Oui Chef's control files`));
    else if (WRITERS.has(tool) && !inWorkspace(ctx, abs)) hits.push(make(ctx, "fs.write.outside", `${tool} ${abs} is outside the cook's station`));
  }
  return settle(hits, ctx, null);
}
