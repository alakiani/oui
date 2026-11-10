// A self-contained world for `oui demo` and the tests: a small git repository,
// stand-ins for kubectl, gh and helm that only print, and a script for the stub
// agents. Nothing here touches your real projects or clusters.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const write = (file, text, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, mode ? { mode } : undefined);
};

const FAKE_KUBECTL = `#!/bin/sh
# demo stand-in: prints, never talks to a cluster
case "$*" in
  *"config current-context"*) echo "staging-eu" ;;
  *" get "*"-o json"*) echo '{"apiVersion":"v1","kind":"List","items":[{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"api","namespace":"shop","resourceVersion":"812","uid":"u-1"},"spec":{"replicas":3,"template":{"spec":{"containers":[{"name":"api","image":"shop/api:1.8.2"}]}}},"status":{"readyReplicas":3}}]}' ;;
  *"rollout status"*) echo 'deployment "api" successfully rolled out' ;;
  *apply*) echo "deployment.apps/api configured" ;;
  *) echo "ok" ;;
esac
`;
const FAKE_GH = `#!/bin/sh
case "$*" in
  *"auth status"*) echo "github.com: logged in as chef" ;;
  *"workflow run"*) echo "Created workflow_dispatch event for ci.yml at main" ;;
  *"run watch"*) echo "Run ci (4411) completed with 'success'" ;;
  *) echo "ok" ;;
esac
`;

const commit = (msg) => ({ run: `git add -A && git commit -qm "${msg}"`, must: true });
const pause = (ms) => ({ sleep: ms });

// What each stub cook does. Keys match the ticket keys in PLAN below.
export function scenario({ slow = 1 } = {}) {
  const s = (ms) => pause(ms * slow);
  return {
    tasks: {
      limiter: [
        { say: "Reading the middleware stack to see where a limiter fits." },
        { run: 'oui note "Reading the middleware stack"' },
        s(1500),
        { write: "src/limiter.js", content: "export const limiter = ({ rate, burst }) => (req, res, next) => next();\n" },
        { write: "test/limiter.test.js", content: "// refills at `rate`, allows `burst`, rejects with 429\n" },
        { run: 'oui note "Token bucket written, tests passing"' },
        s(1200),
        commit("Add token-bucket limiter"),
        { run: 'oui done --summary "Added a token-bucket limiter middleware in src/limiter.js with unit tests for refill, burst and the 429 path." --handoff "Use limiter({ rate, burst }). The bucket key is a function you pass in, so the caller decides what to limit by." --evidence "npm test: 14 passing"' },
      ],
      limits: [
        { say: "The brief leaves open what a limit is counted against." },
        { run: 'oui ask "Should limits be counted per API key or per IP address?" --option "Per API key" --option "Per IP address" --option "Per key, falling back to IP when there is no key" --pick "Per key, falling back to IP when there is no key" --why "It decides the bucket key and what anonymous callers get. Changing it later means resetting every counter."' },
        { end: true },
        { write: "config/limits.json", content: '{ "default": { "rate": 20, "burst": 40 }, "anonymous": { "rate": 5, "burst": 10 } }\n' },
        s(900),
        commit("Add limit tiers"),
        { run: 'oui done --summary "Added config/limits.json with a default and an anonymous tier, keyed as the chef chose." --handoff "Tiers live in config/limits.json; resolveTier(req) picks one." --evidence "Schema check passes"' },
      ],
      wire: [
        { run: 'oui note "Applying the limiter to /v1 routes"' },
        s(1800),
        { write: "src/routes.js", content: "import { limiter } from './limiter.js';\n// app.use('/v1', limiter(resolveTier))\n" },
        commit("Apply limiter to public routes"),
        { run: 'oui msg rollout-staging "Limits are read at boot: the pods need a restart to pick up config/limits.json."' },
        { run: 'oui done --summary "Applied the limiter to every /v1 route; health and internal routes are exempt." --handoff "Limits are read at boot, so a rollout restart is needed after config changes." --evidence "Integration test hits 429 on the 41st request"' },
      ],
      "rollout-staging": [
        { run: "kubectl auth can-i patch deployments -n shop" },
        { run: 'oui note "Applying to staging"' },
        { run: "kubectl apply -f k8s/api.yaml -n shop" },
        s(1500),
        { run: "kubectl rollout status deploy/api -n shop" },
        { run: 'oui done --summary "Rolled the limiter out to staging-eu and confirmed 429s after the burst." --handoff "Staging runs the new image; nothing unusual in the logs over 5 minutes." --evidence "kubectl rollout status: successfully rolled out; curl loop returned 429 on request 41"' },
      ],
      "rollout-prod": [
        { run: 'oui note "Staging looks good, preparing production"' },
        s(800),
        { run: "kubectl --context prod-eu apply -f k8s/api.yaml -n shop" },
        s(1200),
        { run: "kubectl --context prod-eu rollout status deploy/api -n shop" },
        { run: 'oui done --summary "Rolled the limiter out to production (prod-eu) and watched it for errors." --handoff "Production is on the new image." --evidence "rollout status: successfully rolled out"' },
      ],
      node22: [
        { run: 'oui note "Bumping .nvmrc and the CI matrix"' },
        s(1000),
        { write: ".nvmrc", content: "22\n" },
        commit("Use Node 22"),
        { run: 'oui done --summary "Moved .nvmrc and the CI matrix to Node 22." --handoff "Local dev needs nvm use." --evidence "npm test passes on 22.11"' },
      ],
      "ci-run": [
        { run: 'oui need "The GitHub CLI on this machine cannot dispatch workflows: its token has no workflow scope." --fix "gh auth refresh -s workflow"' },
        { end: true },
        { run: "gh workflow run ci.yml" },
        s(1400),
        { run: "gh run watch" },
        { run: 'oui done --summary "Ran the CI workflow on Node 22; all jobs green." --handoff "CI is green on 22." --evidence "Run 4411 succeeded"' },
      ],
      profile: [{ run: 'oui note "Collecting query plans for /checkout"' }, s(4000), { run: 'oui note "EXPLAIN ANALYZE on the three slowest queries"' }, s(600000)],
    },
    roles: {
      // The sous chef passes the product question up, reworded, and would answer a routine one itself.
      triage: [{ run: 'oui escalate {ask} --title "Rate limits: per API key, per IP, or key with IP fallback?" --body "This sets what anonymous callers get. Changing it later resets every counter." --option "Per API key" --option "Per IP address" --option "Per key, falling back to IP" --pick "Per key, falling back to IP"' }],
    },
  };
}

export const PLAN = [
  {
    goal: { title: "Rate-limit the public API", detail: "Add rate limiting to the public API so one noisy client cannot slow everyone down. Ship it to staging, then production." },
    tasks: [
      { key: "limiter", title: "Token-bucket limiter middleware", brief: "Add a token-bucket limiter as Express middleware in src/limiter.js.", accept: ["Unit tests cover refill, burst and the 429 path"] },
      { key: "limits", title: "Limit tiers and what they are keyed by", brief: "Define the limit tiers in config/limits.json.", accept: ["Tiers load at boot and are validated"] },
      { key: "wire", title: "Apply the limiter to public routes", needs: ["limiter", "limits"], brief: "Apply the limiter to every /v1 route.", accept: ["Request 41 in a burst gets a 429"] },
      { key: "rollout-staging", kind: "ops", title: "Roll out to staging and verify", needs: ["wire"], brief: "Deploy to staging-eu and verify.", accept: ["Rollout completes", "429 after the burst"] },
      { key: "rollout-prod", kind: "ops", title: "Roll out to production", needs: ["rollout-staging"], brief: "Deploy to prod-eu and watch it.", accept: ["Rollout completes with no error spike"] },
    ],
  },
  {
    goal: { title: "Move CI to Node 22", detail: "Upgrade our CI and local tooling to Node 22." },
    tasks: [
      { key: "node22", title: "Bump Node to 22", brief: "Update .nvmrc and the CI matrix.", accept: ["Tests pass on 22"] },
      { key: "ci-run", kind: "ops", title: "Run CI on the new version", needs: ["node22"], brief: "Dispatch the CI workflow and confirm it is green.", accept: ["Workflow run succeeds"] },
    ],
  },
  {
    goal: { title: "Find why /checkout got slow", detail: "p95 on /checkout doubled last week. Find out why." },
    tasks: [{ key: "profile", kind: "scout", title: "Profile the checkout queries", brief: "Find the slow queries behind /checkout.", accept: ["A ranked list of causes with evidence"] }],
  },
];

// Builds the demo world under `dir` and returns the environment a daemon needs to run in it.
export function makeDemo(dir, opts = {}) {
  const repo = path.join(dir, "shop-api");
  const bin = path.join(dir, "bin");
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  write(path.join(repo, "README.md"), "# shop-api\n");
  write(path.join(repo, "k8s", "api.yaml"), "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\n");
  write(path.join(repo, "src", "app.js"), "export const app = {};\n");
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "demo@ouichef.local");
  git("config", "user.name", "Oui Chef Demo");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-qm", "Initial commit");
  write(path.join(bin, "kubectl"), FAKE_KUBECTL, 0o755);
  write(path.join(bin, "gh"), FAKE_GH, 0o755);
  // A stand-in herdr-core, so the "herdr" sessions backend can be exercised without Herdr.
  if (opts.hc) write(path.join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(path.dirname(fileURLToPath(import.meta.url)), "harness", "stub-hc.mjs")}" "$@"\n`, 0o755);
  const script = path.join(dir, "scenario.json");
  write(script, JSON.stringify(opts.scenario ?? scenario({ slow: opts.slow ?? 1 }), null, 1));
  write(path.join(home, "config.json"), JSON.stringify({ harness: "stub", sessions: "none", port: opts.port ?? 7331, maxCooks: opts.maxCooks ?? 4, calls: { triage: true, review: true, plan: false }, ...(opts.config ?? {}) }, null, 1));
  return { repo, home, script, env: { ...process.env, OUI_HOME: home, OUI_STUB_SCRIPT: script, OUI_STUB_HC_DIR: path.join(dir, "hc"), OUI_PORT: "", OUI_TOKEN: "", OUI_ROLE: "", PATH: `${bin}${path.delimiter}${process.env.PATH}` } };
}
