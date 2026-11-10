// Claude Code as cook: one headless `claude -p` process per turn. The session
// id is ours, so a turn can be continued later (`--resume`) or opened by the
// chef in a terminal. Permission prompts are answered by nobody: every tool
// call is decided by Oui Chef's PreToolUse hook, and anything the hook does
// not allow is denied. If the hook is ever missing, the agent can do nothing,
// which is the safe way to fail.

import { execFileSync } from "node:child_process";

const BIN = () => process.env.OUI_CLAUDE_BIN || "claude";
let features = null;

function probe() {
  if (features) return features;
  let help = "";
  try {
    help = execFileSync(BIN(), ["--help"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {}
  features = { found: Boolean(help), prompts: help.includes("--permission-prompts"), budget: help.includes("--max-budget-usd"), name: /\s--name\b/.test(help), effort: /\s--effort\b/.test(help) };
  return features;
}

export const name = "claude";

export function available() {
  return probe().found;
}

// run: { prompt, session, resume, settings, system, addDirs, model, effort, budget, label }
export function command(run) {
  const f = probe();
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--settings", run.settings];
  if (f.prompts) args.push("--permission-prompts", "none");
  args.push(run.resume ? "--resume" : "--session-id", run.session);
  if (run.system) args.push("--append-system-prompt", run.system);
  if (run.model) args.push("--model", run.model);
  if (run.effort && f.effort) args.push("--effort", run.effort);
  if (run.budget && f.budget) args.push("--max-budget-usd", String(run.budget));
  if (run.label && f.name) args.push("--name", run.label);
  if (run.addDirs?.length) args.push("--add-dir", ...run.addDirs);
  return { cmd: BIN(), args, stdin: run.prompt, env: {} };
}

// The same cook as an interactive session in a terminal: watchable, and anyone can type into it.
// No stream to read here; the hooks say when a tool is called and when a turn ends.
export function interactive(run) {
  const f = probe();
  const args = ["--permission-mode", "acceptEdits", "--settings", run.settings, run.resume ? "--resume" : "--session-id", run.session];
  if (run.system) args.push("--append-system-prompt", run.system);
  if (run.model) args.push("--model", run.model);
  if (run.effort && f.effort) args.push("--effort", run.effort);
  if (run.label && f.name) args.push("--name", run.label);
  if (run.addDirs?.length) args.push("--add-dir", ...run.addDirs);
  args.push("--", run.prompt);
  return { cmd: BIN(), args, env: {} };
}

// What the chef types to step into a cook's conversation.
export function takeover(session) {
  return [BIN(), "--resume", session];
}

function detail(tool, input) {
  if (!input) return "";
  if (tool === "Bash") return String(input.command ?? "");
  if (input.file_path) return String(input.file_path);
  if (input.pattern) return String(input.pattern);
  if (input.description) return String(input.description);
  if (input.url) return String(input.url);
  if (input.query) return String(input.query);
  return JSON.stringify(input).slice(0, 160);
}

// One line of stream-json -> the few things Oui Chef cares about.
export function parse(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return [];
  }
  if (msg.type === "system" && msg.subtype === "init") return [{ type: "init", session: msg.session_id, model: msg.model }];
  if (msg.type === "assistant" && !msg.parent_tool_use_id) {
    return (msg.message?.content ?? []).flatMap((b) => {
      if (b.type === "text" && b.text?.trim()) return [{ type: "text", text: b.text.trim() }];
      if (b.type === "tool_use") return [{ type: "tool", name: b.name, detail: detail(b.name, b.input) }];
      return [];
    });
  }
  if (msg.type === "user" && !msg.parent_tool_use_id) {
    return (Array.isArray(msg.message?.content) ? msg.message.content : []).flatMap((b) => {
      if (b.type !== "tool_result" || !b.is_error) return [];
      const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => c.text ?? "").join(" ");
      return [{ type: "refused", text: text.slice(0, 300) }];
    });
  }
  if (msg.type === "result") {
    const failed = Boolean(msg.is_error) || (msg.subtype && msg.subtype !== "success");
    return [{ type: "result", ok: !failed, text: msg.result ?? "", error: failed ? (msg.errors ?? []).join("; ") || msg.result || msg.subtype : null, cost: msg.total_cost_usd ?? 0, turns: msg.num_turns ?? 0 }];
  }
  return [];
}
