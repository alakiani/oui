// Where cooks run. A session backend opens a terminal for a ticket and types
// into it; everything else (the plan, the pass, the board) is the same whichever
// one is used. Adding another multiplexer means one file with these functions:
//
//   available()                         is the tool installed?
//   launch({ id, title, group, cwd, argv }) -> handle     open a terminal running argv
//   send(handle, text)                  paste text and submit it
//   alive(handle)                       is the terminal still there?
//   interrupt(handle)                   stop the current turn
//   kill(handle)                        close it
//   read(handle, lines)                 its screen, as text
//   keys(handle, ...names)              press named keys
//   attach(handle) -> argv              what a person runs to step into it
//
// "none" is no backend at all: cooks run headless under the daemon.

import * as herdr from "./herdr.mjs";
import * as tmux from "./tmux.mjs";

export const BACKENDS = { herdr, tmux };

// "auto" is Herdr when herdr-core is installed, otherwise headless. tmux is opt-in.
export function resolve(choice = "auto") {
  if (choice === "none" || choice === false) return null;
  if (choice === "auto") return herdr.available() ? herdr : null;
  const backend = BACKENDS[choice];
  if (!backend) throw new Error(`Unknown sessions backend "${choice}". Known: auto, none, ${Object.keys(BACKENDS).join(", ")}`);
  if (!backend.available()) throw new Error(`sessions is set to "${choice}", but ${choice === "herdr" ? "hc (herdr-core)" : choice} is not installed or not on PATH`);
  return backend;
}
