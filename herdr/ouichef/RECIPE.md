# Oui Chef

The board for [Oui Chef](../../README.md), drawn natively beside your agents. It answers three questions at a glance: what is on the pass for me, what is moving, and what comes next. Narrow, it is one list with the pass on top. Wide, in a tab of its own, every goal is a lane of tickets laid out left to right in the order they must happen, with connectors for what waits on what. You decide from the panel: answer a cook's question, approve or deny a held command, land a finished goal.

**Status.** This mod was written against the mod API as the [Agenttrail mod](https://github.com/sodiumsun/agenttrail/tree/main/herdr/agenttrail) uses it, and it uses no call that mod does not. Its logic, data flow and actions are tested against a live Oui Chef daemon with Herdr's modules replaced by stand-ins (`npm test`, `test/mod.test.mjs`). It has not been run inside Herdr: `herdr-app check` and a look at the real pane are still to do, and "Watch out" lists where a difference is most likely.

## What you see

One view, normally a 360px panel on the right, full height, on Oui Chef's own colours. Dark: `#0e1116` background, `#151a22` panels, `#1b222c` raised, `#29323f` lines, `#e7ebf1` text, `#9ca7b7` dim, `#67727f` faint, `#f2a93b` amber for anything that needs you, `#62a9ff` running, `#40cdb1` next up, `#ab98f8` review, `#5ab884` done, `#f0716a` failed or risky. Light is the same set, chosen by `settings().dark`. From 760px wide the view is *wide*.

- **Header**, 46px: the mark (`mark.svg`, 20px, amber), `Oui Chef`, then `3 running · 12 done` in faint, then a 22px pill: `2 need you` on solid amber, or `Pass is clear` in green, or `Service paused` in amber, or `Not running`. Last, a 26px button that expands the panel into a tab, or collapses the tab.
- **Narrow: one scrolling list**, in this order, each group under an 10.5px capital label with its count:
  - **THE PASS**. One card per ask waiting for you, radius 10, on `#1b222c`. Top line: a kind tag (`QUESTION`, `DECISION`, `ACCESS` in blue, `APPROVE` and `LAND` in red, `STUCK`), the ticket id, `holds up 4` in amber when other tickets wait behind it, and its age. Then the question in 13px semibold, and what depends on it in 12px dim. A held command is shown in a box as `$ kubectl --context prod-eu apply -f k8s/api.yaml`, with `Can be undone: Re-apply the manifests as they were before` in green under it, or `No automatic undo for this one.` in red. Options are one button each, the suggested one outlined in amber and marked `suggested`. Bottom row: `Approve` and `Deny` (or `Land it` and `Not yet`), `Done, try again` for an access request, and `Reply…` on the right.
  - **FAILED**, **RUNNING**, **IN REVIEW**, **NEXT UP**, **WAITING**, **DONE**: one 30px row a ticket: a 7px dot in the state's colour (pulsing every 1600ms while running), the id, the title, and on the right what matters for that state: `#1` for the start order, `after T2, T3` for a waiting ticket, the age for a done one. Running tickets take two lines: the second is the cook's latest note, in blue.
  - **COMMS**: the last 10 messages, `T3 → sous chef  done — Applied the limiter…`, the sender and receiver in their colours (cooks blue, sous chef and inspector violet, chef amber, the pass red).
- **Wide: two columns.** Left, 340px: THE PASS and COMMS as above. Right: one lane per goal. A lane is a header (`G1`, the title, `shop-api · 3/5`, and a state such as `finished · waiting to land`) over its cards. A card is 74px high and as wide as the lane allows (122 to 222px), so a lane always fits across: id, a 6px dot, the state in its colour; the title; the status line. Cards sit in columns, one column to the right of the deepest ticket they need, and level with what they need when there is room. A ticket that needs you has an amber border and tint; a waiting one a dashed border. Connectors are 1.5px curves from the right edge of a ticket to the left edge of each ticket that needs it: solid green at half strength when that need is met, dashed faint while it is open.
- **Nothing to draw**: `Oui Chef is not running` with **Start Oui Chef** in amber (`Starting…` once pressed), or `Oui Chef is not set up here` with the command to run, or `Looking for Oui Chef…`.

## How it behaves

- **Agent status.** The mod does not read Herdr's agent status. Cooks run headless under the Oui Chef daemon, not in Herdr terminals; the mod shows the daemon's view of them. A ticket's state is one of `At the pass`, `Running`, `Resuming`, `In review`, `With sous chef`, `Next up`, `Waiting`, `Stuck upstream`, `Done`, `Failed`, `Paused`.
- **Finding the daemon.** It reads `~/.ouichef/daemon.json` with `cat` for the port, the chef's token and the absolute paths of `node` and `oui`. It reads the file again whenever the daemon stops answering.
- **Polling.** Every 2 seconds it asks `GET /api/board`. Each request has a 4 second limit, and a request still unanswered gets no second one. The daemon must miss two rounds before the view gives it up.
- **Deciding.** A click on an option, `Approve`, `Deny`, `Land it`, `Not yet` or `Done, try again` sends `GET /act?m=<answer|approve|deny>&id=<ask>&t=<token>` and the ask leaves the panel at once. If the daemon refuses, the ask comes back and a red strip says why.
- **Typing.** A mod has no text field, so `Reply…` (and `With a note…` on an approval) opens a tab running `oui answer <ask>`, which shows the ask and takes the answer there.
- **A ticket** row or card opens a tab running `oui tail <ticket> -f`: the cook's activity as it happens.
- **Expand and collapse**, the header button. In the panel it opens a tab named `Oui Chef` with the same mod and `expanded: true`, or selects one already open. In that tab it goes back to the tab it came from and closes its own.
- **Start Oui Chef** opens a tab running `oui up --foreground`. The view notices the daemon by itself.
- **Redraws** happen when the board's revision changes, and at the poll rate while the board is live so ages keep moving.
- **Commands**, for keys of your own or `herdr-app do`: `ouichef.refresh`, `ouichef.expand`, `ouichef.collapse`. No key is bound by default.

## Built from

- **One mod**, `mods/ouichef/`, no layout. `mod.json`: `{ "place": "right", "size": 360, "title": "Oui Chef" }`. Beside a terminal in any tab: `pane.split {direction: "right", mod: "ouichef"}`.
- `main.js`: the view (`gpui-kit` `View`, `div`, `svg`, `PathBuilder`; `gpui-base` `h_flex`, `v_flex`). Two `cx.spawn` loops for the copy's life: the poll, and `nextCommand()`. Size from `on_size_change` on the root.
- `model.js`: `parseDaemon`, `clean`, `sections`, `lanes`, `actionUrl`. No Herdr imports; runs and is tested under plain Node.
- **Art**: `mark.svg`, `expand.svg`, `collapse.svg`.
- **Props**, all optional: `home` (Oui Chef's home when it is not `~/.ouichef`). `expanded` and `from` are set by the mod on its own tab.
- **Herdr functions**: `exec`, `focused`, `home`, `nextCommand`, `panes`, `props`, `run`, `settings`, `spaces`. **Commands**: `terminal.open`, `tab.new`, `tab.select`, `tab.close`.
- **Programs**: `cat ~/.ouichef/daemon.json`; in a terminal when asked, `node <oui> answer|tail|up`, by the absolute paths from `daemon.json`, so nothing depends on the app's `PATH`.
- **Network**: `fetch` GETs to `http://127.0.0.1:<port>` only, where the port is a whole number from `daemon.json`, and only the paths `/api/board` and `/act`.
- **The board**, `GET /api/board`: `rev`, `counts`, `service`, `asks[]` (`id`, `kind`, `ticket`, `title`, `body`, `command`, `options`, `pick`, `undo`, `holds`, `createdAt`), `goals[]`, `tickets[]` (`id`, `goal`, `title`, `state`, `line`, `needs`, `rank`, `next`), `feed[]`. Any local process could answer on the port, so `clean` in `model.js` rebuilds every reply before it is drawn: wrong types become empty, an id must look like `T12`, and a reply without a ticket list is no board.
- **Actions**, `GET /act`: the daemon checks the chef's token on every one, refuses any `Host` that is not localhost and any cross-site `Origin`.

## Watch out

- **Herdr kills a render at 50 ms and never calls it again.** Past 26 ms `main.js` stops adding the least important parts for that frame: COMMS first, then the lower groups, then cards. Lists are capped (6 asks, 8 running, 8 waiting, 5 done, 10 messages) and connectors are built once per lane and reused until the lane changes. A plan with hundreds of tickets in the wide view has not been measured.
- **Unverified in Herdr.** The places most likely to need a change after `herdr-app check`:
  - `exec("cat", [file], { cwd })` is assumed to resolve to `{ code, stdout }`, as it does for `git` in the Agenttrail mod.
  - `fetch(url)` is assumed to give `res.ok` and `res.json()`. Only GET is used, because that is all the Agenttrail mod shows to work.
  - The wide view puts painted connectors (`window.paint_path`) inside a scrolling column (`overflow_y_scrollbar`). If they do not scroll with the cards, draw the lanes without the scroll container or drop the connectors there.
  - The wide view's two columns are a plain `div().flex()` row so they stretch to full height. If they do not, give them an explicit height from `this.size`.
  - Text is left to wrap by default in ask titles and bodies. If it does not wrap, clip with `truncate()` and rely on `Reply…` for the full text.
- **The token is the chef's.** It lets the mod approve held commands, which is the point, and it is read from a file only you can read. The mod never shows it, logs it or sends it anywhere but the daemon on localhost.
- **A mod has no text input**, so anything typed happens in a terminal tab. If Herdr gains one, `Reply…` can become a field.
- `exec` stops after 30 seconds, so the daemon is never started with it. `terminal.open` is used instead.
- Each shown copy polls on its own. One panel is the intended setup; the expanded tab is the only reason for a second.
- This machine only: it reads `~/.ouichef` on the computer Herdr runs on.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/ouichef` passes.
- `npm test` in the Oui Chef repository passes.
- With no daemon, the panel reads `Oui Chef is not running`; **Start Oui Chef** opens a tab and the board replaces the notice within a few seconds.
- `oui demo` in a terminal, with `"home"` in the mod's props set to the demo's home: asks appear under THE PASS within seconds; clicking an option answers it and the waiting tickets behind it start.
- A held command shows its `$ command` and its undo line; `Approve` lets the cook run it, and the ticket turns `Done`.
- `Reply…` opens a tab with the ask and takes a typed answer.
- The header button opens a `Oui Chef` tab with lanes and connectors in dependency order, and the same button there returns to the panel.
- Clicking a ticket opens its activity in a tab.
- Stopping the daemon (`oui down`) returns the view to `Oui Chef is not running` within about 6 seconds.
