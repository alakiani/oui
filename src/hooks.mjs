// Claude Code hooks. `oui hook pretool` runs before every tool call an agent
// makes and prints the decision Claude Code acts on. It judges the call here,
// in the agent's own environment (so it sees the same kube context and env
// vars the command would), then asks the daemon what to do about it.

import os from "node:os";
import path from "node:path";
import { home, loadConfig } from "./paths.mjs";
import { loadPolicy } from "./guard/policy.mjs";
import { classifyTool } from "./guard/classify.mjs";
import { capture } from "./guard/undo.mjs";
import { DaemonDown, rpc } from "./client.mjs";

async function stdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

const list = (name) => {
  try {
    return JSON.parse(process.env[name] || "[]");
  } catch {
    return [];
  }
};

function answer(decision, reason, context) {
  const out = { hookEventName: "PreToolUse", permissionDecision: decision };
  if (reason) out.permissionDecisionReason = reason;
  if (context) out.additionalContext = context;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
}

export async function pretool() {
  const input = await stdin();
  const tool = input.tool_name ?? "";
  const args = input.tool_input ?? {};
  const role = process.env.OUI_ROLE || "cook";
  if (tool === "AskUserQuestion") return answer("deny", "Nobody is at this terminal to answer. Ask through Oui Chef instead: oui ask \"<question>\" --option \"<A>\" --option \"<B>\" --pick \"<your choice>\", then carry on or end your turn.");
  const cwd = input.cwd || process.cwd();
  // The agent's own scratch space and session notes count as its station.
  const roots = [...list("OUI_ROOTS"), input.scratchpad_dir, path.join(os.homedir(), ".claude", "projects")].filter(Boolean);
  const verdict = classifyTool(tool, args, { cwd, roots, env: process.env, role, home: home(), port: process.env.OUI_PORT || loadConfig().port, policy: loadPolicy(), protectedBranches: list("OUI_PROTECTED") });
  // Reading and in-station edits need no round trip.
  if (verdict.tier === 0 && tool !== "Bash") return answer("allow");
  let res;
  try {
    res = await rpc("guard", { tool, input: args, cwd, verdict }, { timeoutMs: 20000 });
  } catch (e) {
    if (verdict.tier === 0) return answer("allow");
    const down = e instanceof DaemonDown;
    return answer("deny", down ? `Oui Chef's daemon is not reachable, so this cannot be recorded or approved (${verdict.why}). Stop here and end your turn; it needs the chef to run: oui up` : `Oui Chef's guard could not decide (${e.message}). Do not retry in a loop; end your turn.`);
  }
  if (res.decision !== "allow") return answer("deny", res.reason, res.context);
  if (res.capture?.length && res.dir) {
    const results = await capture(res.capture, res.dir, { cwd, env: process.env });
    await rpc("guard.captured", { action: res.action, results }, { timeoutMs: 10000 }).catch(() => {});
  }
  return answer("allow", undefined, res.context);
}

export async function stop() {
  const input = await stdin();
  try {
    const res = await rpc("hook.stop", { active: Boolean(input.stop_hook_active), last: String(input.last_assistant_message ?? "").slice(0, 2000) }, { timeoutMs: 8000 });
    if (res.block) process.stdout.write(JSON.stringify({ decision: "block", reason: res.reason }));
  } catch {
    // A daemon that is down must never trap an agent in its turn.
  }
}
