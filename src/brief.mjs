// What each agent is told. A cook gets its ticket, the goal in the chef's
// words, and the handoff notes of the tickets it builds on: never anyone's
// transcript. That is how context stays small as the plan grows.
//
// The words themselves are in prompts/. A file of the same name in the home's
// prompts folder wins over the built-in one, so a kitchen can be run its own
// way without touching the code. Files are read on every use: an edit applies
// to the next cook, plan, review or conversation, with no restart.

import fs from "node:fs";
import path from "node:path";
import { P, ROOT } from "./paths.mjs";

// Every prompt file, and what it steers. `oui prompts` prints this.
export const PROMPTS = {
  "sous.md": "the sous chef you talk to in `oui sous`: how a goal is talked through and planned",
  "tickets.md": "how tickets are cut and briefed, for the sous chef and the planner alike",
  "roles.md": "the planner behind `oui go`, the triage of cooks' questions, and the inspector",
  "cook.md": "what every cook is told",
};

export const builtinPrompt = (name) => path.join(ROOT, "prompts", name);
export const ownPrompt = (name) => path.join(P.prompts(), name);

// The chef's own copy may not exist. A built-in one that is missing is a broken install, and says so.
const own = (name) => {
  try {
    return fs.readFileSync(ownPrompt(name), "utf8");
  } catch {
    return "";
  }
};
const builtin = (name) => fs.readFileSync(builtinPrompt(name), "utf8");

// -> the file in use: the chef's own when there is one with something in it, else the built-in.
export function promptFile(name) {
  return own(name).trim() ? ownPrompt(name) : builtinPrompt(name);
}

const read = (name) => (own(name).trim() ? own(name) : builtin(name));

function sections(text) {
  return Object.fromEntries(
    text
      .split(/^## /m)
      .filter(Boolean)
      .map((s) => {
        const i = s.indexOf("\n");
        return i < 0 ? [s.trim(), ""] : [s.slice(0, i).trim(), s.slice(i + 1).trim()];
      }),
  );
}

// roles.md holds one section per judgement call. The chef's own file may carry only the ones it changes.
const roleTemplate = (kind) => sections(own("roles.md"))[kind] || sections(builtin("roles.md"))[kind];

export const cookContract = () => read("cook.md");

const bullets = (list, empty = "- (none given: use the brief)") => (list?.length ? list.map((x) => `- ${x}`).join("\n") : empty);

const preferenceBlock = (notes, lead) => (notes ? `\n## The chef's standing preferences\n${lead}\n${notes}\n` : "");
const preferences = (kitchen) => preferenceBlock(kitchen.preferences(), "Follow these unless the brief says otherwise.");

// What the chef has settled for a goal through `decide` tickets, and what is still with them,
// so that no cook builds on a guess and nobody asks the same thing twice.
function decisions(s, goalId) {
  const asked = Object.values(s.tasks).filter((t) => t.goal === goalId && t.kind === "decide" && t.status !== "cancelled");
  if (!asked.length) return "";
  const line = (t) => `- ${t.title} → ${t.decision ?? (t.status === "done" ? "left open by the chef: use your judgement" : "still with the chef")}`;
  return `\n## Decisions for this goal\n${asked.map(line).join("\n")}\n`;
}

function mail(items) {
  return items.map((m) => {
    if (m.kind === "answer") return `Answer to ${m.ask} (“${m.question}”), from the ${m.by === "sous" ? "sous chef" : "chef"}: ${m.text}`;
    if (m.kind === "approved") return `${m.ask} APPROVED by the chef${m.text ? ` (${m.text})` : ""}. Run it now, exactly as you wrote it:\n    ${m.command}`;
    if (m.kind === "denied") return `${m.ask} DENIED by the chef${m.text ? `: ${m.text}` : ""}. Do not run it or reach the same effect another way${m.command ? `:\n    ${m.command}` : "."}`;
    if (m.kind === "msg") return `Message from ${m.from}: ${m.text}`;
    return m.text;
  });
}

// The rest of the goal in a few lines, so a cook knows who to tell when something changes.
function others(s, task) {
  const rest = Object.values(s.tasks).filter((t) => t.goal === task.goal && t.id !== task.id && t.kind !== "decide" && !["cancelled"].includes(t.status) && !task.needs.includes(t.id));
  if (!rest.length) return "";
  return `\n## Other tickets in this goal\n${rest.slice(0, 12).map((t) => `- ${t.id} “${t.title}” (${t.status === "todo" ? (t.needs.includes(task.id) ? "waits for you" : "not started") : t.status})`).join("\n")}\nTell another cook something with \`oui msg <T-id> "..."\`. Their work is theirs; do not do it for them.`;
}

export function cookBrief(kitchen, task) {
  const s = kitchen.state;
  const goal = s.goals[task.goal];
  const project = s.projects[task.project];
  const upstream = task.needs.map((id) => s.tasks[id]).filter((t) => t && t.kind !== "decide"); // decisions have a section of their own
  const where =
    task.branch && project.git
      ? `Your station is \`${task.workdir}\`, a git worktree of ${project.name} on branch \`${task.branch}\`, cut from \`${goal.branch}\` (the branch for this goal, which already contains the finished tickets you build on). The base branch \`${project.base}\` does not have that work unless a land step came before you.\n${task.kind === "ops" ? "This is an ops ticket: you act on systems from here. If it also needs file changes, commit them on this branch." : "Commit your work on this branch."} Do not push this branch, open a pull request for it or merge it: when you report done, Oui Chef checks the work, merges it into \`${goal.branch}\` and lands the goal as a whole.`
      : task.kind === "scout"
        ? `Work from \`${task.workdir}\`. This is an investigation: change nothing. Your report is the result, so make \`--summary\` and \`--handoff\` carry the findings, and write anything longer to \`${kitchen.taskDir(task.id)}/findings.md\`.`
        : `Work from \`${task.workdir}\` (${project.name}).${project.git ? "" : " It is not a git repository, so there is no branch to hide behind: change only what the ticket needs."}`;
  const checks = [...(project.verify ?? []), ...(task.verify ?? [])];
  const waiting = mail(task.inbox.splice(0));
  return [
    `# ${task.id}: ${task.title}`,
    `Part of goal ${goal.id}: ${goal.title}`,
    goal.detail && goal.detail !== goal.title ? `\n## The goal, in the chef's words\n${goal.detail}` : "",
    decisions(s, goal.id).trimEnd(),
    `\n## What to do\n${task.brief}`,
    `\n## Done when\n${bullets(task.accept)}`,
    checks.length ? `\nThese must pass before you report done; Oui Chef runs them again afterwards:\n${checks.map((c) => `- \`${c}\``).join("\n")}` : "",
    `\n## Your station\n${where}`,
    upstream.length ? `\n## What came before\n${upstream.map((u) => `- ${u.id} “${u.title}”: ${u.report?.handoff || u.report?.summary || "(no notes)"}`).join("\n")}` : "",
    others(s, task),
    waiting.length ? `\n## Waiting for you\n${waiting.map((w) => `- ${w}`).join("\n")}` : "",
    preferences(kitchen),
  ]
    .filter(Boolean)
    .join("\n");
}

// The message a parked cook is resumed with: decisions, answers and anything sent to it.
export function resumeMessage(task) {
  const waiting = task.inbox.splice(0);
  if (waiting.length === 1 && waiting[0].kind === "composed") return waiting[0].text;
  const items = mail(waiting);
  if (!items.length) return "Carry on with your ticket.";
  return `${items.join("\n\n")}\n\nCarry on. When the ticket is finished, report with oui done.`;
}

function fill(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key) => vars[key] ?? "");
}

// The manual the sous chef reads when the chef opens a conversation with `oui sous`.
export function sousManual(notes = "") {
  return fill(read("sous.md"), { tickets: read("tickets.md").trim(), preferences: preferenceBlock(notes, "These come before anything else on this page.") });
}

export function rolePrompt(kind, kitchen, ctx) {
  const s = kitchen.state;
  const template = roleTemplate(kind);
  if (!template) throw new Error(`No prompt for role ${kind}`);
  const prefs = preferences(kitchen);
  if (kind === "plan") {
    const project = s.projects[ctx.goal.project];
    return fill(template, { detail: ctx.goal.detail, goal: ctx.goal.id, project: project.name, path: project.path, git: project.git ? ` (git, base branch \`${project.base}\`, finished goals land ${project.landing === "pr" ? "as a pull request" : "by local merge"})` : " (not a git repository)", preferences: prefs, tickets: read("tickets.md").trim() });
  }
  const task = ctx.task ?? (ctx.ask?.task ? s.tasks[ctx.ask.task] : null);
  const goal = task ? s.goals[task.goal] : null;
  const project = task ? s.projects[task.project] : null;
  if (kind === "triage") {
    const a = ctx.ask;
    return fill(template, {
      ticket: task?.id ?? "",
      title: task?.title ?? "",
      goal: goal?.id ?? "",
      goalTitle: goal?.title ?? "",
      brief: task?.brief ?? "",
      detail: goal?.detail ?? "",
      decisions: goal ? decisions(s, goal.id) : "",
      preferences: prefs,
      ask: a.id,
      question: a.title,
      body: a.body ? `Why it matters: ${a.body}` : "",
      options: a.options?.length ? `Options they see: ${a.options.join(" | ")}${a.pick ? `. They would pick: ${a.pick}` : ""}` : "",
      path: project?.path ?? "",
    });
  }
  if (kind === "review") {
    const checks = [...(project.verify ?? []), ...(task.verify ?? [])];
    // What the pass saw this cook do outside its station: Oui Chef's own record, so the inspector need not take the report's word for it.
    const ran = kitchen.ledger.filter((a) => a.task === task.id && ["ran", "approved"].includes(a.decision));
    const actions = ran.length
      ? `Oui Chef's own record of what this cook ran outside its station (not the cook's claim; each of these did run):\n${ran.map((a) => `- ${a.id} ${a.decision === "approved" ? `ran with the chef's approval${a.ask ? ` (${a.ask})` : ""}` : "ran"}: ${a.command}`).join("\n")}`
      : "Oui Chef recorded no commands outside the station for this ticket.";
    return fill(template, {
      actions,
      ticket: task.id,
      title: task.title,
      brief: task.brief,
      accept: bullets(task.accept),
      decisions: decisions(s, goal.id),
      summary: task.report?.summary ?? "",
      evidence: task.report?.evidence || "none",
      branch: task.branch ?? "",
      workdir: task.workdir,
      base: goal.branch ?? project.base ?? "",
      checks: checks.length ? `\nOui Chef already ran these and they passed: ${checks.map((c) => `\`${c}\``).join(", ")}.` : "",
    });
  }
  throw new Error(`No prompt for role ${kind}`);
}
