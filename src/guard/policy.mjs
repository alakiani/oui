// The chef's risk policy. Defaults live here; ~/.ouichef/policy.json
// overrides them. Every rule the classifier can fire has an id, and
// `tiers` lets the chef move any rule up or down:
//
//   0  read-only or routine: runs, not recorded
//   1  changes something, but can be put back: runs, recorded with an undo recipe
//   2  high blast radius or hard to reverse: held until the chef approves
//   3  never: refused outright (tampering with Oui Chef itself)

import { P, readJson } from "../paths.mjs";

export const DEFAULT_POLICY = {
  // Branches nobody pushes to or rewrites without the chef. `*` matches within a segment and across.
  protectedBranches: ["main", "master", "trunk", "production", "prod", "release/*", "releases/*", "stable"],
  // What counts as production. `words` are matched as whole words inside kube contexts,
  // namespaces, hostnames, URLs, workflow names, env values and script names.
  prod: {
    words: ["prod", "production", "prd", "live"],
    contexts: [], // extra exact names or globs, e.g. "gke_acme_us-east1_main"
    namespaces: [],
    hosts: [],
  },
  // Clusters that are always treated as scratch space, whatever they are called.
  safe: {
    contexts: ["kind-*", "minikube", "docker-desktop", "k3d-*", "rancher-desktop", "orbstack", "colima*"],
  },
  // Opaque scripts and targets (make X, npm run X, ./X.sh) are held when their name contains one of these.
  riskyNames: ["deploy", "release", "publish", "rollout", "migrate", "destroy", "teardown", "nuke", "wipe", "prod", "production"],
  // Rule id -> tier. See `oui policy rules` for every id and its default.
  tiers: {},
  // Whole-command patterns (glob with *, or /regex/). First match wins, checked deny, hold, allow.
  deny: [],
  hold: [],
  allow: [],
  // How long an approval stays usable if the cook does not run the command straight away.
  grantMinutes: 120,
};

export function loadPolicy(file = P.policy()) {
  const user = readJson(file, {}) ?? {};
  return {
    ...DEFAULT_POLICY,
    ...user,
    prod: { ...DEFAULT_POLICY.prod, ...(user.prod ?? {}) },
    safe: { ...DEFAULT_POLICY.safe, ...(user.safe ?? {}) },
    tiers: { ...DEFAULT_POLICY.tiers, ...(user.tiers ?? {}) },
  };
}

const escape = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

// "release/*" style globs, or "/regex/" for anything fancier.
export function patternToRegex(pattern) {
  const m = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (m) {
    try {
      return new RegExp(m[1], m[2]);
    } catch {
      return /$^/;
    }
  }
  return new RegExp(`^${pattern.split("*").map(escape).join(".*")}$`, "i");
}

export function matchesAny(patterns, value) {
  if (value == null) return false;
  return (patterns ?? []).some((p) => patternToRegex(p).test(String(value)));
}

// "prod" inside "acme-prod-eu" or "api.prod.acme.io", but not inside "product" or "reproduce".
export function hasProdWord(policy, value) {
  if (!value) return false;
  const words = (policy.prod?.words ?? []).map(escape).join("|");
  if (!words) return false;
  return new RegExp(`(^|[^a-z0-9])(${words})([^a-z0-9]|$)`, "i").test(String(value));
}

export function isProtectedBranch(policy, branch, extra = []) {
  if (!branch) return false;
  return matchesAny([...(policy.protectedBranches ?? []), ...extra], branch.replace(/^refs\/heads\//, ""));
}

// Where a kubectl/helm command lands: "prod", "safe" (a local scratch cluster) or "other".
export function kubeZone(policy, context, namespace) {
  if (context && matchesAny(policy.safe?.contexts, context)) return "safe";
  if (matchesAny(policy.prod?.contexts, context) || hasProdWord(policy, context)) return "prod";
  if (matchesAny(policy.prod?.namespaces, namespace) || hasProdWord(policy, namespace)) return "prod";
  return "other";
}

export function hasRiskyName(policy, name) {
  if (!name) return false;
  const words = (policy.riskyNames ?? []).map(escape).join("|");
  if (!words) return false;
  return new RegExp(`(^|[^a-z0-9])(${words})([^a-z0-9]|$)`, "i").test(String(name));
}
