// Cooks as tmux windows: one session (default "oui"), one window per ticket.
// Attach with `tmux attach -t oui` and you are looking at the kitchen.

import { execFile, execFileSync } from "node:child_process";

const SESSION = () => process.env.OUI_TMUX_SESSION || "oui";

export const name = "tmux";

export function available() {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function tmux(args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    execFile("tmux", args, { timeout: timeoutMs, encoding: "utf8" }, (error, stdout, stderr) => resolve({ ok: !error, out: String(stdout ?? "").trim(), err: String(stderr ?? error?.message ?? "").trim() }));
  });
}

export async function launch({ id, title, cwd, argv }) {
  const label = `${title}`.replace(/[\n\r]/g, " ").slice(0, 40);
  const has = await tmux(["has-session", "-t", `=${SESSION()}`]);
  // With several words after the options, tmux runs them as a program, not through a shell.
  const tail = ["-P", "-F", "#{pane_id}", "-n", label, "-c", cwd, "--", ...argv];
  const res = has.ok ? await tmux(["new-window", "-d", "-t", `=${SESSION()}:`, ...tail]) : await tmux(["new-session", "-d", "-s", SESSION(), "-x", "200", "-y", "50", ...tail]);
  if (!res.ok || !/^%\d+$/.test(res.out)) throw new Error(res.err || `tmux could not open a window for ${id}`);
  await tmux(["set-option", "-w", "-t", res.out, "remain-on-exit", "off"]);
  return res.out;
}

// Pasted as one block, so new lines in a message do not submit it early.
export async function send(handle, text) {
  const buffer = `oui-${handle.slice(1)}`;
  const set = await tmux(["set-buffer", "-b", buffer, "--", text]);
  if (!set.ok) throw new Error(set.err);
  const paste = await tmux(["paste-buffer", "-p", "-d", "-b", buffer, "-t", handle]);
  if (!paste.ok) throw new Error(paste.err);
  await new Promise((r) => setTimeout(r, 400));
  const enter = await tmux(["send-keys", "-t", handle, "Enter"]);
  if (!enter.ok) throw new Error(enter.err);
}

export async function alive(handle) {
  const res = await tmux(["display-message", "-p", "-t", handle, "#{pane_dead}"]);
  return res.ok && res.out === "0";
}

export const interrupt = (handle) => tmux(["send-keys", "-t", handle, "Escape"]);
export const keys = (handle, ...names) => tmux(["send-keys", "-t", handle, ...names.map((k) => ({ enter: "Enter", esc: "Escape", down: "Down", up: "Up" })[k] ?? k)]);
export const read = async (handle, lines = 0) => (await tmux(["capture-pane", "-p", "-t", handle, "-S", `-${lines}`])).out;
export const kill = (handle) => tmux(["kill-pane", "-t", handle]);
export const attach = (handle) => ["tmux", "attach", "-t", SESSION(), ";", "select-pane", "-t", handle];
