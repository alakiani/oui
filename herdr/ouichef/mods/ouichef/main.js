// Oui Chef, drawn natively in Herdr. A side panel that answers three
// questions at a glance: what needs me, what is moving, what comes next. Wide
// (in a tab of its own) it also shows every goal as a lane of tickets, left to
// right in the order they must happen.
//
// It reads the board from the Oui Chef daemon on 127.0.0.1 and sends the
// chef's decisions back. It starts nothing by itself except, when asked, a
// terminal running oui. See model.js for everything that is not drawing.

import { View, div, svg, PathBuilder } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { exec, focused, home, nextCommand, notify, panes, playSound, props, readTextFile, run, settings, spaces, terminals, theme } from "herdr";
import { CARD_H, DEFAULT_HOME, KIND, POLL_MS, STATE, TIMEOUT_MS, WIDE, actionUrl, ago, boardUrl, clean, lanes, parseDaemon, sections } from "./model.js";

const MOD = "ouichef";
const ASSET = `mods/${MOD}`;
const TAB = "Oui Chef"; // the expanded tab's name, how the panel finds it again
// Herdr stops a view whose render takes 50 ms and never calls it again, so a
// slow frame sheds its least important parts instead of finishing.
const RENDER_BUDGET_MS = 26;

const DARK = { bg: "#0e1116", panel: "#151a22", raised: "#1b222c", hover: "#232c39", line: "#29323f", text: "#e7ebf1", dim: "#9ca7b7", faint: "#67727f", amber: "#f2a93b", amberBg: "#f2a93b22", amberInk: "#1a1305", blue: "#62a9ff", teal: "#40cdb1", violet: "#ab98f8", green: "#5ab884", red: "#f0716a", redBg: "#f0716a22", blueBg: "#62a9ff22" };
const LIGHT = { bg: "#f4f5f7", panel: "#ffffff", raised: "#f1f3f6", hover: "#e6eaf0", line: "#dbe0e8", text: "#151a23", dim: "#566174", faint: "#8b95a4", amber: "#b06500", amberBg: "#b0650018", amberInk: "#ffffff", blue: "#1d6cd3", teal: "#0c8a73", violet: "#6851d0", green: "#2c8251", red: "#c5403a", redBg: "#c5403a18", blueBg: "#1d6cd318" };
// The person's Herdr theme, by the roles this view needs, so it follows whatever look they chose.
// Oui Chef's own colours stand in for any name a theme does not have.
const tint = (hex, alpha, fallback) => (/^#[0-9a-f]{6}$/i.test(hex ?? "") ? `${hex}${alpha}` : fallback);
function paint(t, light) {
  const d = light ? LIGHT : DARK;
  const pick = (name, fallback) => (typeof t?.[name] === "string" && t[name] ? t[name] : fallback);
  const amber = pick("blocked", d.amber), blue = pick("working", d.blue), red = pick("ansi1", d.red);
  return {
    bg: pick("chrome", d.bg), panel: pick("surface", d.panel), raised: pick("raised", d.raised), hover: pick("hover", d.hover), line: pick("border", d.line),
    text: pick("foreground", d.text), dim: pick("muted", d.dim), faint: pick("dim", d.faint),
    amber, amberBg: tint(amber, "22", d.amberBg), amberInk: pick("background", d.amberInk), blue, blueBg: tint(blue, "22", d.blueBg),
    teal: pick("accent", d.teal), violet: pick("ansi5", d.violet), green: pick("done", d.green), red, redBg: tint(red, "22", d.redBg),
  };
}
const tone = (c, state) => ({ needs_you: c.amber, running: c.blue, blocked: c.blue, review: c.violet, with_sous: c.violet, ready: c.teal, done: c.green, failed: c.red, stuck: c.red })[state] ?? c.faint;
const who = (c, name) => (name.startsWith("cook") ? c.blue : name === "sous" || name === "inspector" ? c.violet : name === "chef" ? c.amber : name.startsWith("pass") ? c.red : c.faint);
const short = (name) => (name.startsWith("cook:") ? name.slice(5) : name.startsWith("pass") ? "the pass" : name === "sous" ? "sous chef" : name);

export default class OuiChef extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.expanded = Boolean(p.expanded);
    this.from = p.from ?? null; // the tab an expanded copy goes back to
    this.homeDir = typeof p.home === "string" && p.home ? p.home : `${home()}/${DEFAULT_HOME}`;
    this.size = null;
    this.daemon = null;
    this.board = null;
    this.state = "looking"; // looking | absent | stopped | live
    this.misses = 0;
    this.waiting = false; // a board request is still unanswered
    this.sent = new Set(); // asks already decided here, hidden until the board catches up
    this.inputs = new Map(); // ask id -> its text field, kept between redraws so typing is never lost
    this.known = null; // the asks seen so far, to notice a new one
    this.starting = false;
    this.error = null;
    cx.spawn(async (cx) => {
      for (;;) {
        const changed = await this.tick(cx);
        // Ages ("3m") move with the clock, so a live board redraws at the poll rate.
        if (changed || this.state === "live") cx.notify();
        await Promise.race([cx.sleep(POLL_MS), new Promise((wake) => { this.wake = wake; })]);
      }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "refresh") this.wake?.();
        else if (command === "expand") { if (!this.expanded) this.toggleSize(); }
        else if (command === "collapse") { if (this.expanded) this.toggleSize(); }
        else continue;
        cx.notify();
      }
    });
  }

  // ---- talking to the daemon

  async readDaemon() {
    const file = `${this.homeDir}/daemon.json`;
    let text = await readTextFile(file).catch(() => null);
    if (text == null) {
      const res = await exec("cat", [file], { cwd: home() }).catch(() => null);
      text = res?.code === 0 ? res.stdout : null;
    }
    return text ? parseDaemon(text) : null;
  }

  // One request at a time, with a deadline: a fetch that never answers must not pile more up behind it.
  async get(url, cx) {
    if (!url) return null;
    const answer = fetch(url).then((res) => (res.ok ? res.json() : null)).catch(() => null);
    return Promise.race([answer, cx.sleep(TIMEOUT_MS).then(() => null)]);
  }

  async tick(cx) {
    const before = `${this.state}|${this.board?.rev}`;
    if (!this.daemon || this.misses > 0) this.daemon = await this.readDaemon();
    if (!this.daemon) {
      this.state = "absent";
      this.board = null;
    } else if (!this.waiting) {
      this.waiting = true;
      const reply = clean(await this.get(boardUrl(this.daemon), cx));
      this.waiting = false;
      if (reply) {
        this.misses = 0;
        this.board = reply;
        this.state = "live";
        this.starting = false;
        for (const id of [...this.sent]) if (!reply.asks.some((a) => a.id === id)) this.sent.delete(id);
        this.announce(reply);
      } else if (++this.misses >= 2 || !this.board) {
        this.state = "stopped";
        this.board = null;
      }
    }
    return before !== `${this.state}|${this.board?.rev}`;
  }

  // A chef's decision. The ask disappears at once; the next poll confirms it.
  act(method, params, cx) {
    const url = actionUrl(this.daemon, method, params);
    if (!url) return;
    if (params.id) this.sent.add(params.id);
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const res = await this.get(url, cx);
      if (!res || res.ok === false) {
        if (params.id) this.sent.delete(params.id);
        this.error = res?.error ?? "Oui Chef did not answer. Nothing was changed.";
      }
      this.wake?.();
      cx.notify();
    });
  }

  // Something new on the pass: say so the Herdr way, with a toast and the "needs you" sound.
  announce(board) {
    const ids = new Set(board.asks.map((a) => a.id));
    const fresh = this.known ? board.asks.filter((a) => !this.known.has(a.id)) : [];
    if (fresh.length) {
      const a = fresh[0];
      const terminal = a.task ? this.terminalOf(a.task) : null;
      notify({ title: fresh.length === 1 ? `${a.task || a.goal || "Oui Chef"} is at the pass` : `${fresh.length} new on the pass`, body: a.title, level: "warning", ...(terminal ? { action: { name: "terminal.peek", args: { terminal } } } : {}) });
      playSound("blocked");
    }
    this.known = ids;
    for (const id of [...this.inputs.keys()]) if (!ids.has(id)) this.inputs.delete(id);
  }

  // The Herdr address of a cook's terminal, found by the label Oui Chef starts it with.
  terminalOf(ticket) {
    const mine = (t) => (Array.isArray(t?.labels) ? t.labels.includes(`oui.ticket=${ticket}`) : t?.labels?.["oui.ticket"] === ticket);
    const found = (terminals() ?? []).find((t) => mine(t) && t.state !== "finished");
    return typeof found?.address === "string" ? found.address : null;
  }

  // A ticket opens its cook: a peek at its live terminal when Herdr has one, else its activity log.
  open(id) {
    const terminal = this.terminalOf(id);
    if (terminal) return run("terminal.peek", { terminal });
    return this.terminal(["tail", id, "-f"], `${id} activity`);
  }

  field(a) {
    let state = this.inputs.get(a.id);
    if (!state) {
      state = InputState.new({ value: "" });
      state.on("submit", (_e, cx) => this.reply(a, "yes", cx));
      this.inputs.set(a.id, state);
    }
    return state;
  }

  // What was typed is the answer to a question, or the note that goes with a decision.
  reply(a, verdict, cx) {
    const text = String(this.inputs.get(a.id)?.value() ?? "").trim();
    if (a.kind === "approval" || a.kind === "land") return this.act(verdict === "no" ? "deny" : "approve", { id: a.id, note: text }, cx);
    if (text) this.act("answer", { id: a.id, text }, cx);
  }

  // Things easier read in a terminal open one.
  terminal(args, name) {
    const d = this.daemon;
    if (!d?.node || !d?.oui) return;
    run("terminal.open", { argv: [d.node, d.oui, ...args], folder: home(), place: "tab", name });
  }

  startDaemon(cx) {
    this.starting = true;
    this.terminal(["up", "--foreground"], "Oui Chef daemon");
    this.wake?.();
    cx.notify();
  }

  // The panel opens a tab with the wide view; that tab's button closes it and goes back.
  toggleSize() {
    const f = focused();
    if (this.expanded) {
      if (this.from && spaces().some((s) => s.tabs.some((t) => t.id === this.from))) run("tab.select", { id: this.from });
      return run("tab.close", { id: f.tab });
    }
    const tabs = spaces().find((s) => s.id === f?.space)?.tabs ?? [];
    const open = tabs.find((t) => t.name === TAB && panes().some((p) => p.tab === t.id && p.mod === MOD));
    if (open) return run("tab.select", { id: open.id });
    return run("tab.new", { name: TAB, mod: MOD, props: { ...(props() ?? {}), expanded: true, from: f?.tab ?? null } });
  }

  late() {
    return Date.now() - this.t0 > RENDER_BUDGET_MS;
  }

  // ---- pieces

  button(c, id, label, action, kind = "plain") {
    const look = { go: [c.amber, c.amberInk, c.amber], no: [c.panel, c.red, c.line], plain: [c.panel, c.text, c.line] }[kind];
    return div().id(id).h(28).px(10).flex().flex_none().items_center().rounded(7).border(1).border_color(look[2]).bg(look[0]).text_size(12).font_weight(600).text_color(look[1])
      .cursor_pointer().hover((s) => s.border_color(kind === "no" ? c.red : c.amber)).on_click(action).child(label);
  }

  label(c, text, count) {
    return h_flex().mt(14).pb(6).gap(6).items_center().flex_none().text_size(10.5).font_weight(700).text_color(c.faint)
      .child(text).when(count != null, (el) => el.child(div().text_color(c.amber).child(String(count))));
  }

  dot(c, state, size = 7) {
    const el = div().w(size).h(size).rounded(size).flex_none().bg(tone(c, state));
    return state === "running" ? el.loop("opacity", { from: 0.3, to: 1, period: 1600 }) : el;
  }

  ask(c, a, now) {
    const kindColor = a.kind === "approval" || a.kind === "land" ? [c.red, c.redBg] : a.kind === "access" ? [c.blue, c.blueBg] : [c.amber, c.amberBg];
    const answer = (text) => (_e, cx) => this.act("answer", { id: a.id, text }, cx);
    const decision = a.kind === "approval" || a.kind === "land";
    return v_flex().id(`ask-${a.id}`).mt(6).p(11).gap(5).rounded(10).border(1).border_color(c.line).bg(c.raised).flex_none()
      .child(h_flex().gap(7).items_center().text_size(11).text_color(c.faint)
        .child(div().px(5).rounded(4).bg(kindColor[1]).text_color(kindColor[0]).text_size(10).font_weight(700).child(KIND[a.kind] ?? a.kind.toUpperCase()))
        .child(div().flex_none().child(a.task || a.goal))
        .when(a.holds > 1, (el) => el.child(div().flex_none().text_color(c.amber).font_weight(600).child(`holds up ${a.holds}`)))
        .child(div().flex_1().min_w(0))
        .child(div().flex_none().child(ago(a.createdAt, now))))
      .child(div().min_w(0).text_size(13).font_weight(600).text_color(c.text).child(a.title))
      .when(Boolean(a.body), (el) => el.child(div().min_w(0).text_size(12).text_color(c.dim).child(a.body.length > 260 ? `${a.body.slice(0, 259)}…` : a.body)))
      .when(Boolean(a.command), (el) => el.child(div().min_w(0).p(7).rounded(6).bg(c.bg).border(1).border_color(c.line).text_size(11.5).text_color(c.text).child(`$ ${a.command}`)))
      .when(a.undo.length > 0, (el) => el.child(div().min_w(0).text_size(11.5).text_color(c.green).child(`Can be undone: ${a.undo[0]}`)))
      .when(decision && a.kind === "approval" && !a.undo.length, (el) => el.child(div().text_size(11.5).text_color(c.red).child("No automatic undo for this one.")))
      .when(!decision && a.options.length > 0, (el) => el.child(v_flex().mt(3).gap(5).children(a.options.map((o, i) =>
        h_flex().id(`ask-${a.id}-o${i}`).px(9).py(6).gap(6).rounded(7).border(1).border_color(o === a.pick ? c.amber : c.line).bg(c.panel).cursor_pointer()
          .hover((s) => s.border_color(c.amber)).on_click(answer(o))
          .child(div().flex_1().min_w(0).text_size(12.5).text_color(c.text).child(o))
          .when(o === a.pick, (e2) => e2.child(div().flex_none().text_size(10.5).font_weight(600).text_color(c.amber).child("suggested")))))))
      .child(Input.new(this.field(a)).mt(4).h(30).px(8).rounded(7).border(1).border_color(c.line).bg(c.panel).text_size(12.5).text_color(c.text))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(c.faint).child(decision ? "A note for the cook, if you like" : "Your answer, then Enter"))
        .when(decision, (el) => el
          .child(this.button(c, `ask-${a.id}-yes`, a.kind === "land" ? "Land it" : "Approve", (_e, cx) => this.reply(a, "yes", cx), "go"))
          .child(this.button(c, `ask-${a.id}-no`, a.kind === "land" ? "Not yet" : "Deny", (_e, cx) => this.reply(a, "no", cx), "no")))
        .when(a.kind === "access", (el) => el.child(this.button(c, `ask-${a.id}-done`, "Done, try again", answer("Done. Try again."), "go")))
        .when(!decision, (el) => el.child(this.button(c, `ask-${a.id}-send`, "Send", (_e, cx) => this.reply(a, "yes", cx)))));
  }

  // One ticket as a single line: enough for a list.
  row(c, t, now, tail) {
    return h_flex().id(`row-${t.id}`).h(30).px(8).gap(8).items_center().rounded(7).flex_none().cursor_pointer().hover((s) => s.bg(c.hover))
      .on_click(() => this.open(t.id))
      .child(this.dot(c, t.state))
      .child(div().flex_none().w(26).text_size(11).text_color(c.faint).child(t.id))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.state === "done" ? c.dim : c.text).child(t.title))
      .child(div().flex_none().max_w(150).truncate().text_size(11.5).text_color(t.state === "failed" ? c.red : c.faint).child(tail));
  }

  // The same ticket with its status line under it, for what is moving right now.
  rowWide(c, t, now) {
    return v_flex().id(`row-${t.id}`).px(8).py(6).gap(2).rounded(7).flex_none().cursor_pointer().hover((s) => s.bg(c.hover))
      .on_click(() => this.open(t.id))
      .child(h_flex().gap(8).items_center()
        .child(this.dot(c, t.state))
        .child(div().flex_none().w(26).text_size(11).text_color(c.faint).child(t.id))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_weight(600).text_color(c.text).child(t.title))
        .child(div().flex_none().text_size(11).text_color(c.faint).child(t.activeAt ? ago(t.activeAt, now) : "")))
      .child(h_flex().gap(8)
        .child(div().w(33).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(tone(c, t.state)).child(t.line)));
  }

  event(c, e) {
    return h_flex().px(8).py(3).gap(6).flex_none().text_size(11.5)
      .child(div().flex_none().font_weight(600).text_color(who(c, e.from)).child(short(e.from)))
      .child(div().flex_none().text_color(c.faint).child("→"))
      .child(div().flex_none().font_weight(600).text_color(who(c, e.to)).child(short(e.to)))
      .child(div().flex_1().min_w(0).truncate().text_color(c.dim).child(e.text));
  }

  inbox(c, s, now) {
    const asks = s.asks.filter((a) => !this.sent.has(a.id));
    return [
      this.label(c, "THE PASS", asks.length || null),
      ...asks.slice(0, 6).map((a) => this.ask(c, a, now)),
      ...(asks.length > 6 ? [div().px(8).pb(6).text_size(12).text_color(c.amber).child(`and ${asks.length - 6} more`)] : []),
      ...(asks.length ? [] : [div().px(8).pb(4).text_size(12.5).text_color(c.dim).child(this.board.counts.withSous ? "The pass is clear. The sous chef is answering a cook's question." : "The pass is clear.")]),
    ];
  }

  comms(c, b, max) {
    if (this.late()) return [];
    const talk = b.feed.filter((e) => e.type !== "note" && e.type !== "system").slice(-max).reverse();
    return talk.length ? [this.label(c, "COMMS"), ...talk.map((e) => this.event(c, e))] : [];
  }

  // The narrow panel: one scrolling list, most urgent first.
  list(c, b, now) {
    const s = sections(b);
    const group = (title, items, draw, max) => (items.length && !this.late() ? [this.label(c, title, items.length), ...items.slice(0, max).map(draw), ...(items.length > max ? [div().px(8).text_size(11.5).text_color(c.faint).child(`and ${items.length - max} more`)] : [])] : []);
    return v_flex().id("list").flex_1().min_h(0).px(10).pb(12).overflow_y_scrollbar()
      .children(this.inbox(c, s, now))
      .children(group("FAILED", s.failed, (t) => this.row(c, t, now, t.line), 4))
      .children(group("RUNNING", s.running, (t) => this.rowWide(c, t, now), 8))
      .children(group("IN REVIEW", s.review, (t) => this.row(c, t, now, t.line), 4))
      .children(group("NEXT UP", s.next, (t) => this.row(c, t, now, t.next ? `#${t.next}` : ""), 6))
      .children(group("WAITING", s.waiting, (t) => this.row(c, t, now, t.line), 8))
      .children(group("DONE", s.done, (t) => this.row(c, t, now, t.finishedAt ? ago(t.finishedAt, now) : ""), 5))
      .children(this.comms(c, b, 10));
  }

  card(c, t, x, y, w) {
    const color = tone(c, t.state);
    return v_flex().id(`card-${t.id}`).absolute().left(x).top(y).w(w).h(CARD_H).px(9).py(7).gap(2).rounded(9).border(1).border_color(t.state === "needs_you" ? c.amber : c.line)
      .bg(t.state === "needs_you" ? c.amberBg : c.panel).cursor_pointer().hover((s) => s.border_color(color))
      .when(t.state === "waiting" || t.state === "paused", (el) => el.border_dashed())
      .on_click(() => this.open(t.id))
      .child(h_flex().gap(6).items_center().text_size(10.5)
        .child(div().flex_none().text_color(c.faint).child(t.id))
        .child(this.dot(c, t.state, 6))
        .child(div().flex_1().min_w(0).truncate().font_weight(600).text_color(color).child(t.state === "ready" && t.next ? `Next up · #${t.next}` : STATE[t.state] ?? t.state)))
      .child(div().min_w(0).truncate().text_size(12.5).font_weight(600).text_color(t.state === "done" ? c.dim : c.text).child(t.title))
      .child(div().min_w(0).truncate().text_size(11).text_color(t.state === "needs_you" ? c.amber : c.dim).child(t.line));
  }

  // Connectors for one lane, as two paths: needs that are met, and needs still open.
  edges(c, lane) {
    const draw = (list, dashed) => {
      if (!list.length) return null;
      let path = PathBuilder.stroke(1.5);
      if (dashed) path = path.dash_array([4, 5]);
      for (const e of list) {
        const bend = Math.max(12, (e.x2 - e.x1) / 2);
        path = path.move_to(e.x1, e.y1).cubic_bezier_to(e.x2, e.y2, e.x1 + bend, e.y1, e.x2 - bend, e.y2);
      }
      return path.build();
    };
    const key = `${lane.goal.id}|${lane.width}|${lane.edges.map((e) => `${e.x1},${e.y1},${e.x2},${e.y2},${e.met}`).join(";")}|${settings()?.dark}`;
    this.edgeCache ??= new Map();
    if (this.edgeCache.get(lane.goal.id)?.key !== key) this.edgeCache.set(lane.goal.id, { key, met: draw(lane.edges.filter((e) => e.met), false), open: draw(lane.edges.filter((e) => !e.met), true) });
    const cached = this.edgeCache.get(lane.goal.id);
    const layer = (path, color) => window.paint_path(path, color).absolute().left(0).top(0).w(lane.width).h(lane.height);
    return [cached.met ? layer(cached.met, `${c.green}88`) : null, cached.open ? layer(cached.open, c.faint) : null].filter(Boolean);
  }

  lane(c, lane) {
    const g = lane.goal;
    const state = g.status === "planning" ? "sous chef is planning" : g.status === "done" ? (g.pr ? "in a pull request" : g.landed ? "landed" : "complete") : g.total && g.done === g.total ? "finished · waiting to land" : g.status === "active" ? "" : g.status;
    return v_flex().pb(22).flex_none()
      .child(h_flex().pb(9).gap(8).items_center()
        .child(div().flex_none().text_size(11).text_color(c.faint).child(g.id))
        .child(div().min_w(0).truncate().text_size(14).font_weight(600).text_color(c.text).child(g.title))
        .child(div().flex_none().text_size(11.5).text_color(c.faint).child(`${g.project} · ${g.done}/${g.total}`))
        .when(Boolean(state), (el) => el.child(div().flex_none().px(7).rounded(9).bg(c.raised).text_size(11).text_color(g.status === "done" ? c.green : c.dim).child(state))))
      .child(div().relative().w(lane.width).h(lane.height).flex_none()
        .children(this.late() ? [] : this.edges(c, lane))
        .children(lane.cards.map((k) => (this.late() ? null : this.card(c, k.task, k.x, k.y, lane.cardW))).filter(Boolean)));
  }

  // The wide view: inbox and comms on the left, every goal's flow on the right.
  wide(c, b, now) {
    const s = sections(b);
    const side = 340;
    const room = Math.max(300, this.size.width - side - 56);
    // A plain flex row, not h_flex: its children stretch to the full height, which the two scrolling columns need.
    return div().flex().flex_1().min_h(0)
      .child(v_flex().id("side").w(side).flex_none().min_h(0).px(10).pb(12).overflow_y_scrollbar()
        .children(this.inbox(c, s, now))
        .children(this.comms(c, b, 16)))
      .child(div().w(1).flex_none().bg(c.line))
      .child(v_flex().id("flow").flex_1().min_w(0).min_h(0).px(20).py(16).overflow_y_scrollbar()
        .children(lanes(b, room).map((l) => this.lane(c, l)))
        .when(!b.goals.length, (el) => el.child(div().text_size(13).text_color(c.dim).child('No goals yet. Hand one over from a terminal: oui go "…"'))));
  }

  header(c, b) {
    const n = b ? b.asks.filter((a) => !this.sent.has(a.id)).length : 0;
    const pill = !b ? [this.state === "looking" ? "Looking…" : "Not running", c.faint, c.raised] : n ? [`${n} need${n === 1 ? "s" : ""} you`, c.amberInk, c.amber] : !b.service.on ? ["Service paused", c.amber, c.amberBg] : ["Pass is clear", c.green, c.raised];
    return h_flex().h(46).px(12).gap(9).items_center().flex_none().border_b(1).border_color(c.line).bg(c.panel)
      .child(svg(`${ASSET}/mark.svg`).w(20).h(20).flex_none().text_color(c.amber))
      .child(div().flex_1().min_w(0).truncate().text_size(13.5).font_weight(600).text_color(c.text).child("Oui Chef"))
      .when(Boolean(b), (el) => el.child(div().flex_none().text_size(11.5).text_color(c.faint).child(`${b.counts.running} running · ${b.counts.done} done`)))
      .child(div().flex_none().h(22).px(8).flex().items_center().rounded(11).bg(pill[2]).text_size(11.5).font_weight(600).text_color(pill[1]).child(pill[0]))
      .child(div().id("size").w(26).h(26).flex().flex_none().items_center().justify_center().rounded(7).text_color(c.dim).cursor_pointer().hover((s) => s.bg(c.hover).text_color(c.text))
        .on_click((_e, cx) => { this.toggleSize(); cx.notify(); })
        .child(svg(`${ASSET}/${this.expanded ? "collapse" : "expand"}.svg`).w(14).h(14)));
  }

  // Nothing to draw yet: say why, and offer the one thing that fixes it.
  notice(c) {
    const words = {
      looking: ["Looking for Oui Chef…", null],
      absent: ["Oui Chef is not set up here", `There is no ${this.homeDir}/daemon.json. In a terminal, run: oui up`],
      stopped: ["Oui Chef is not running", "Cooks are parked. Starting it picks up where they left off."],
    }[this.state] ?? ["Oui Chef", null];
    const canStart = this.state === "stopped" && this.daemon?.node && this.daemon?.oui;
    return v_flex().id("notice").size_full().min_h(0).p(16).gap(6)
      .child(div().text_size(14).font_weight(600).text_color(this.state === "looking" ? c.dim : c.text).child(words[0]))
      .when(Boolean(words[1]), (el) => el.child(div().text_size(12.5).text_color(c.dim).child(words[1])))
      .when(Boolean(canStart), (el) => el.child(h_flex().mt(8).child(this.starting
        ? div().h(28).flex().items_center().text_size(12.5).text_color(c.dim).child("Starting…")
        : this.button(c, "start", "Start Oui Chef", (_e, cx) => this.startDaemon(cx), "go"))));
  }

  render() {
    this.t0 = Date.now();
    const c = paint(theme(), settings()?.dark === false);
    const b = this.state === "live" ? this.board : null;
    const now = Date.now();
    const isWide = (this.size?.width ?? 0) >= WIDE;
    return v_flex().id("root").size_full().min_h(0).bg(c.bg)
      .on_size_change((size, cx) => {
        if (size.width === this.size?.width && size.height === this.size?.height) return;
        this.size = size;
        cx.notify();
      })
      .child(this.header(c, b))
      .when(Boolean(this.error), (el) => el.child(div().px(12).py(6).flex_none().bg(c.redBg).text_size(12).text_color(c.red).child(this.error ?? "")))
      .when(Boolean(b) && isWide, (el) => el.child(this.wide(c, b, now)))
      .when(Boolean(b) && !isWide, (el) => el.child(this.list(c, b, now)))
      .when(!b, (el) => el.child(this.notice(c)));
  }
}
