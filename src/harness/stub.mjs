// A scripted stand-in for a coding agent. It speaks the same stream-json as
// Claude Code and runs its "tool calls" through the real hooks and the real oui
// CLI, so tests and `oui demo` exercise the whole loop without a model.

import path from "node:path";
import { ROOT } from "../paths.mjs";
import { parse as parseClaude } from "./claude.mjs";

export const name = "stub";
export const available = () => true;

export function command(run) {
  return {
    cmd: process.execPath,
    args: [path.join(ROOT, "src", "harness", "stub-agent.mjs")],
    stdin: run.prompt,
    env: {
      OUI_STUB_SESSION: run.session,
      OUI_STUB_RESUME: run.resume ? "1" : "",
      OUI_STUB_SETTINGS: run.settings,
      OUI_STUB_KEY: run.stubKey ?? "",
      OUI_STUB_KIND: run.kind ?? "cook",
    },
  };
}

export const takeover = (session) => ["echo", `stub session ${session} has no terminal to open`];
export const parse = parseClaude;
