// Every rule at the pass: its default tier and what it means in plain
// words. `oui policy rules` prints this table, and policy.json's `tiers` can
// move any id. Tiers: 0 run · 1 run + record undo · 2 hold for the chef · 3 never.

export const RULES = {
  // git
  "git.push": [1, "Push a branch that is not protected"],
  "git.push.force": [1, "Force-push a branch that is not protected"],
  "git.push.delete": [1, "Delete a remote branch that is not protected"],
  "git.push.protected": [2, "Push straight to a protected branch"],
  "git.push.force.protected": [2, "Force-push a protected branch"],
  "git.push.delete.protected": [2, "Delete a protected remote branch"],
  "git.push.mirror": [2, "Mirror-push, which overwrites every remote ref"],
  "git.history.rewrite": [2, "Rewrite or expire repository history"],
  "git.branch.delete": [1, "Delete a local branch"],
  "git.branch.delete.protected": [2, "Delete a protected local branch"],
  "git.outside.change": [1, "Change a repository outside the cook's station"],
  "git.outside.protected": [2, "Change a protected branch in a checkout outside the cook's station"],
  "git.outside.discard": [2, "Throw away uncommitted work outside the cook's station"],
  // GitHub / GitLab
  "forge.pr.merge": [2, "Merge a pull request"],
  "forge.pr.write": [1, "Open, edit, comment on or close a pull request"],
  "forge.issue.write": [1, "Open, edit, comment on or close an issue"],
  "forge.pipeline.run": [1, "Start, re-run or cancel a pipeline"],
  "forge.pipeline.run.prod": [2, "Start a pipeline whose name or inputs say deploy, release or production"],
  "forge.release": [2, "Create, edit or delete a release"],
  "forge.repo.admin": [2, "Delete, archive, rename or change the visibility of a repository"],
  "forge.secret": [2, "Change repository secrets or variables"],
  "forge.api.write": [1, "Write through the forge API"],
  "forge.api.delete": [2, "Delete through the forge API"],
  "forge.auth": [2, "Change forge credentials"],
  // Kubernetes
  "kube.change": [1, "Change resources in a cluster that is not production"],
  "kube.change.prod": [2, "Change resources in a production cluster or namespace"],
  "kube.delete.wide": [2, "Delete a namespace, node, volume or CRD, or delete with --all"],
  "kube.drain": [2, "Drain a node"],
  "kube.exec": [1, "Run a command inside a pod that is not in production"],
  "kube.exec.prod": [2, "Run a command inside a production pod"],
  "kube.config": [1, "Change the local kube config"],
  // Helm
  "helm.change": [1, "Install, upgrade, roll back or uninstall a release outside production"],
  "helm.change.prod": [2, "Install, upgrade, roll back or uninstall a production release"],
  // Infrastructure as code, cloud, GitOps
  "iac.apply": [2, "Apply or destroy infrastructure (terraform, tofu, pulumi, cdk)"],
  "iac.state": [2, "Edit infrastructure state"],
  "cloud.change": [1, "Create or change a cloud resource"],
  "cloud.change.prod": [2, "Create or change a production cloud resource"],
  "cloud.delete": [2, "Delete or terminate a cloud resource"],
  "gitops.sync": [1, "Sync or reconcile a GitOps application"],
  "gitops.sync.prod": [2, "Sync or reconcile a production GitOps application"],
  "gitops.delete": [2, "Delete a GitOps application"],
  // Containers and packages
  "docker.push": [1, "Push a container image"],
  "docker.prune": [2, "Delete Docker volumes or prune everything"],
  "publish.package": [2, "Publish a package or chart to a public registry"],
  // Databases
  "db.write": [1, "Write to a database that is not production"],
  "db.write.prod": [2, "Write to a production database"],
  "db.destroy": [2, "Drop, truncate or delete without a filter"],
  "db.migrate": [1, "Run database migrations outside production"],
  "db.migrate.prod": [2, "Run database migrations against production"],
  // Files and the machine
  "fs.rm.outside": [2, "Delete a directory tree outside the cook's station"],
  "fs.rm.file.outside": [1, "Delete a file outside the cook's station"],
  "fs.perm.outside": [2, "Recursively change ownership or permissions outside the cook's station"],
  "fs.disk": [2, "Write to a raw disk or wipe a device"],
  "fs.write.outside": [2, "Write a file outside the cook's station"],
  "mcp.call": [1, "Call a connected tool (MCP) that is not plainly read-only"],
  "sys.service": [1, "Start, stop or restart a system service"],
  "sys.power": [2, "Shut down or reboot the machine"],
  "sys.sudo": [2, "Run something as root that Oui Chef cannot see into"],
  // Network and remote machines
  "net.pipe.shell": [2, "Download a script and run it"],
  "net.http.write": [1, "Send a write request to an HTTP API"],
  "net.http.write.prod": [2, "Send a write request to a production HTTP API"],
  "ssh.remote": [1, "Change something on a remote machine"],
  "ssh.remote.prod": [2, "Change something on a production machine"],
  // Things Oui Chef cannot see into
  "script.risky": [2, "Run a script or target whose name says deploy, release, migrate or destroy"],
  "agent.nested": [2, "Start another coding agent that would run outside the guard"],
  // Oui Chef itself
  "oui.tamper": [3, "Touch Oui Chef's own control files, tokens or chef-only commands"],
};

export function defaultTier(rule) {
  return RULES[rule]?.[0] ?? 1;
}

export function tierOf(rule, policy) {
  const set = policy?.tiers?.[rule];
  if (set === "deny" || set === "never") return 3;
  if (set === "hold" || set === "ask") return 2;
  if (set === "allow") return 1;
  if (Number.isInteger(set) && set >= 0 && set <= 3) return set;
  return defaultTier(rule);
}

export const TIER_NAME = ["run", "run + undo", "hold", "never"];

// The oui commands each kind of agent may run. Everything else is the chef's.
export const ROLE_VERBS = {
  cook: ["ask", "need", "msg", "note", "done", "fail", "inbox", "propose", "show", "status", "help"],
  sous: ["answer", "escalate", "plan", "msg", "note", "show", "status", "log", "help"],
  inspector: ["verdict", "msg", "show", "status", "log", "help"],
};
