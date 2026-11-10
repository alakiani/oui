#!/usr/bin/env node
// The scripted agent behind the stub harness. It reads a scenario
// (OUI_STUB_SCRIPT), finds the steps for its ticket or role, and plays them:
//
//   { "say": "text" }                       assistant text
//   { "run": "shell command" }              a Bash tool call, through the PreToolUse hook
//   { "write": "file", "content": "..." }   a Write tool call, through the hook
//   { "sleep": 400 }                        think for a while
//   { "end": true }                         end the turn here; the next turn continues after it
//
// A refused tool call ends the turn, as a well-behaved agent would; the next
// turn starts by trying the same step again. Where it is in the script is kept
// beside the session, so `--resume` behaves like the real thing.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const env = process.env;
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const session = env.OUI_STUB_SESSION || "stub";
const scenario = (() => {
  try {
    return JSON.parse(fs.readFileSync(env.OUI_STUB_SCRIPT, "utf8"));
  } catch {
    return {};
  }
})();
const speed = Number(env.OUI_STUB_SPEED ?? scenario.speed ?? 1);
const settings = (() => {
  try {
    return JSON.parse(fs.readFileSync(env.OUI_STUB_SETTINGS, "utf8"));
  } catch {
    return {};
  }
})();

const DEFAULTS = {
  cook: [{ say: "Working on it." }, { run: 'oui note "working"' }, { sleep: 200 }, { run: 'oui done --summary "Did the work as briefed." --handoff "Nothing special."' }],
  triage: [{ run: "oui escalate {ask}" }],
  review: [{ run: 'oui verdict {ticket} pass --notes "Reads fine."' }],
  message: [{ run: 'oui answer {ask} "Noted."' }],
  plan: [],
};

function steps() {
  const kind = env.OUI_STUB_KIND || "cook";
  if (kind === "cook") {
    const t = scenario.tasks ?? {};
    return t[env.OUI_STUB_KEY] ?? t[env.OUI_TASK] ?? t["*"] ?? DEFAULTS.cook;
  }
  const r = scenario.roles ?? {};
  // An inspector of the chef's own ("review: security") does what any inspector does, unless the scenario says otherwise.
  const base = kind.split(":")[0];
  return r[`${kind}:${env.OUI_STUB_KEY}`] ?? r[kind] ?? r[`${base}:${env.OUI_STUB_KEY}`] ?? r[base] ?? DEFAULTS[base] ?? [];
}

const fill = (s) =>
  String(s)
    .replace(/\{ticket\}/g, env.OUI_TASK ?? "")
    .replace(/\{ask\}/g, env.OUI_ASK ?? "")
    .replace(/\{goal\}/g, env.OUI_GOAL ?? "")
    .replace(/\{repo\}/g, env.OUI_STUB_REPO ?? "")
    .replace(/\{cwd\}/g, process.cwd());

function hook(event, payload) {
  const entry = (settings.hooks?.[event] ?? [])[0]?.hooks?.[0];
  if (!entry?.command) return null;
  const res = spawnSync("sh", ["-c", entry.command], { input: JSON.stringify({ session_id: session, cwd: process.cwd(), hook_event_name: event, ...payload }), encoding: "utf8", env });
  if (res.status === 2) return { blocked: true, reason: res.stderr.trim() };
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

let n = 0;
function tool(nameOfTool, input, execute) {
  const id = `toolu_stub_${++n}`;
  out({ type: "assistant", session_id: session, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "tool_use", id, name: nameOfTool, input }] } });
  const verdict = hook("PreToolUse", { tool_name: nameOfTool, tool_input: input, tool_use_id: id });
  const decision = verdict?.hookSpecificOutput?.permissionDecision;
  // Like headless Claude Code: with nobody to prompt, only an explicit allow runs.
  if (decision !== "allow") {
    const reason = verdict?.hookSpecificOutput?.permissionDecisionReason ?? verdict?.reason ?? "Permission denied: no hook allowed this tool call.";
    out({ type: "user", session_id: session, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: reason }] } });
    return { ok: false, denied: true, text: reason };
  }
  const res = execute();
  const extra = verdict?.hookSpecificOutput?.additionalContext;
  out({ type: "user", session_id: session, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: !res.ok, content: res.text + (extra ? `\n${extra}` : "") }] } });
  return res;
}

const stateFile = path.join(path.dirname(env.OUI_STUB_SETTINGS || "."), `stub-${session}.json`);
const state = (() => {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return { at: 0, denied: {} };
  }
})();
const saveState = () => fs.writeFileSync(stateFile, JSON.stringify(state));

// One turn: play the script from where it stopped until something ends the turn.
async function playTurn(prompt, active = false) {
  const list = steps();
  let turns = 0;
  let last = "";
  // A cook told "no" does not try that step a third time; it moves on.
  const refusedAgain = /already said no|DENIED|said no to/i.test(prompt);
  if (refusedAgain && list[state.at]?.run) state.at++;

  for (; state.at < list.length; state.at++) {
    const step = list[state.at];
    if (step.sleep) await sleep(step.sleep / speed);
    else if (step.say) {
      last = fill(step.say);
      out({ type: "assistant", session_id: session, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: last }] } });
    } else if (step.run || step.write) {
      turns++;
      const res = step.run
        ? tool("Bash", { command: fill(step.run) }, () => {
            const r = spawnSync("sh", ["-c", fill(step.run)], { encoding: "utf8", env, cwd: process.cwd() });
            return { ok: r.status === 0, text: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().slice(0, 2000) };
          })
        : tool("Write", { file_path: path.resolve(fill(step.write)), content: step.content ?? "" }, () => {
            const file = path.resolve(fill(step.write));
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, step.content ?? "");
            return { ok: true, text: `Wrote ${file}` };
          });
      if (res.denied) {
        // Held or refused: stop here. A hold is retried next turn; a refusal is skipped.
        if (!/HELD/.test(res.text)) state.at++;
        last = "I'll stop here until that is decided.";
        out({ type: "assistant", session_id: session, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: last }] } });
        break;
      }
      if (!res.ok && step.must) {
        last = `Command failed: ${res.text.slice(0, 200)}`;
        state.at++;
        break;
      }
    } else if (step.end) {
      state.at++;
      break;
    }
  }
  saveState();

  const stop = hook("Stop", { stop_hook_active: active, last_assistant_message: last });
  if (stop?.decision === "block") {
    // Told not to stop yet: read why and carry on in the same turn, as a real agent does.
    out({ type: "user", session_id: session, parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: `Stop hook feedback: ${stop.reason}` }] } });
    return playTurn(stop.reason, true);
  }
  out({ type: "result", subtype: "success", is_error: false, session_id: session, result: last, num_turns: turns, total_cost_usd: 0, duration_ms: 0 });
}

out({ type: "system", subtype: "init", session_id: session, model: "stub", cwd: process.cwd(), tools: ["Bash", "Write"] });
if (env.OUI_STUB_INTERACTIVE) {
  // In a terminal: the first message came with the launch, the rest are typed in. One burst of input is one message.
  let queue = playTurn(env.OUI_STUB_PROMPT ?? "");
  let buffer = "";
  let timer = null;
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const message = buffer;
      buffer = "";
      queue = queue.then(() => playTurn(message));
    }, 250);
  });
  process.stdin.on("end", () => queue.then(() => process.exit(0)));
} else {
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  await playTurn(prompt);
}
