# Oui Chef

An orchestrator for coding agents, run like a kitchen. You give the order. A sous chef breaks it into tickets with an order of their own, cooks carry them out at their stations, and you are interrupted only for what is yours to decide. One board shows what is waiting on you, what is cooking and what comes next.

See it at **[alakiani.github.io/oui](https://alakiani.github.io/oui/)**: the page has a small service you can click through.

> **In a starred kitchen, the chef doesn't cook every dish. But every plate goes out under the chef's name.**
>
> Oui Chef works the same way: your agents do the cooking, and nothing that matters leaves the pass without you.

![The board](docs/board.png)

During service the chef stands at **the pass**: the counter every plate crosses on its way out. Orders are called from there, each station gets on with its part, and nothing leaves until the chef has seen it. Oui Chef gives you that seat for your coding agents.

- **You do not keep track of sessions.** Every ticket, in every project, is on one board. The top of it is the only list you need to read: *the pass*.
- **Order is part of the plan.** Tickets say what they need. Each one is fired when what it needs is finished, and the board shows that order left to right.
- **Cooks run their own commands.** They use git, gh, kubectl, helm, cloud CLIs and pipelines themselves. They never ask you to run something and paste the output. When they lack access they tell you exactly what to grant, once.
- **Risky is held, reversible is recorded.** Every command crosses the pass before it runs. Most go straight through. Changes to shared systems go through and are recorded with a recipe to undo them. Merging, production, deleting what cannot be recreated and publishing wait there for your approval.
- **Small contexts.** A cook sees its ticket, the goal in your words and a few lines from the tickets it builds on. The sous chef reads a digest, never a transcript. State lives on disk, so any conversation can be closed and nothing is lost.

## The kitchen

```
you ── goal ─▶ sous chef ── tickets, with needs ─▶ expediter ─▶ cook, one per ticket
 ▲                                                    │              │
 │                                                    │    every tool call
 └──── the pass: questions · access · approvals ◀─────┴──────────────┘
                                                      │
                                      inspector checks finished work,
                                      expediter merges it, you land the goal
```

| | What it is | What it does |
|---|---|---|
| **Chef** | You | Give goals, answer what only you can, approve what is risky |
| **Sous chef** | A model, called for short judgement calls | Turns a goal into tickets; answers cooks' questions the goal already settles and passes the rest up, reworded |
| **Inspector** | A model, read-only | Checks each finished build ticket against its brief before it merges |
| **Cook** | One Claude Code session per ticket, at its own station (a git worktree): a terminal in Herdr or tmux, or headless | Does the work, commits, reports |
| **Expediter** | Plain code, no model | Fires tickets in order, delivers answers, runs checks, merges, lands |
| **The pass** | Plain code, a hook on every tool call | Lets it through, records it with an undo, holds it for you, or refuses |

Everything mechanical is code. A model is used only where judgement is needed, each time from a few paragraphs, ending in one command.

## Install

Needs Node 20 or newer, git, and [Claude Code](https://code.claude.com) logged in (`claude` on your PATH). `gh`, `kubectl` and the rest are used when your tickets need them.

```bash
git clone https://github.com/alakiani/oui.git
cd oui
npm link        # puts `oui` on your PATH
npm test        # 50 tests; takes under a minute
```

There are no dependencies to install. New here? [Getting started](docs/getting-started.md) walks from the demo to your first real goal, then to Herdr.

## A first service, without touching anything real

```bash
oui demo
```

This starts a throwaway kitchen: a scratch repository, stand-in cooks that follow a script, and a fake `kubectl` and `gh` that only print. Open the address it prints. Within a few seconds a cook's question arrives at the pass; answer it and watch the tickets behind it fire, until a production rollout is held for your approval.

## Using it

```bash
oui up                                   # start the kitchen; prints the board's address
oui project add ~/code/api               # register a repository
oui go "Add rate limiting to the public API and roll it out to staging"
```

`oui go` hands the goal to the sous chef, who reads the repository and writes the tickets and their order. Anything only you can decide becomes a question on the pass straight away: the tickets that need the answer wait for it, and the rest start as soon as the plan is in.

To see the plan before anything starts:

```bash
oui go "Add rate limiting to the public API" --plan ask     # this goal only
oui project add ~/code/api --plan ask                       # every goal in this project
```

The plan then waits on the pass as one ask: the tickets, what waits on what, and a note from the sous chef on how it cut the work and what it assumed. Answer "Cook it" (or `oui approve A2`), or say in your own words what to change and the sous chef plans again with that. For a small goal this is one read in place of a conversation.

To talk a goal through first, with you in the loop:

```bash
oui sous                                 # an interactive Claude Code session that knows how to plan
```

By default the sous chef reads the repository first, then asks you in rounds: every question it can ask at that point, numbered, each with the answer it would give, so "yes to all" is a valid reply. Say "cook it" at any time and it decides the rest and tells you what it assumed. How much it asks, and how, is yours to change: see [Make it yours](#make-it-yours).

Then decide, from the board or the terminal:

```bash
oui status                               # what is on the pass, and where everything stands
oui answer A3 "Per API key"              # or: oui answer A3   (shows the ask and prompts)
oui approve A5 --note "window is open"   # let a held command through
oui deny A5 --note "not before Monday"
oui approve A5 --always                  # and never hold this exact command again
```

And look closer when you want to:

```bash
oui tail T4 -f                           # a cook's activity
oui takeover T4                          # step into its conversation; the pass stays in place
oui log                                  # who said what to whom
oui actions                              # everything changed outside a station, with its undo
oui undo X12                             # show the recipe;  --yes runs it
```

`oui help` lists the rest.

### What a ticket goes through

`waiting` (something it needs is unfinished) → `next up` → `running` → `in review` (your project's checks, then the inspector, or [inspectors](#more-than-one-inspector)) → merged into the goal's branch → `done`. On the way it can be `at the pass` (an open question, access request or held command), `with sous chef` (a question the sous chef may be able to answer), or sent back to its cook with the reason.

Finished tickets merge into one branch per goal, so later tickets start from everything before them. When a goal is finished you get one ask: land it. Landing is a fast-forward of your base branch (`landing: local`) or one pull request (`landing: pr`). A plan can also contain a `land` ticket in the middle, for work that must be on the base branch before a pipeline or rollout runs.

A question for you can be a ticket too. A `decide` ticket has no cook: it goes to the pass as soon as what it needs is finished, without waiting for a free cook. Only the tickets that need its answer wait; everything else keeps cooking. Your answer finishes the ticket, and every cook in the goal that starts afterwards is told what you decided.

### Plans

A plan is a goal and tickets with `needs`. The sous chef writes them; you can too:

```bash
oui plan - <<'EOF'
{ "goal": { "title": "Rate-limit the public API", "detail": "…", "project": "api" },
  "tickets": [
    { "key": "limiter", "title": "Token-bucket middleware", "brief": "…", "accept": ["unit tests cover refill and 429"] },
    { "key": "keyed",   "kind": "decide", "title": "Count limits per API key or per IP?", "brief": "It sets what anonymous callers get.",
      "options": ["Per API key", "Per IP"], "pick": "Per API key" },
    { "key": "wire",    "title": "Apply it to /v1 routes", "needs": ["limiter", "keyed"], "brief": "…" },
    { "key": "land",    "kind": "land", "title": "Land before deploying", "needs": ["wire"] },
    { "key": "rollout", "kind": "ops",  "title": "Deploy to staging and verify", "needs": ["land"], "brief": "…" }
  ] }
EOF
```

`kind` is `build` (changes code), `ops` (acts on clusters, pipelines, deploys), `scout` (investigates and reports), `decide` (a question for you, with `options` and the plan's `pick`) or `land`. Here the limiter is built while the question is open, and only `wire` waits for your answer.

### Kitchen calls

The plain words work everywhere. So do the kitchen's:

| You say | It means |
|---|---|
| `oui fire "<goal>"` | `oui go`: hand over a goal |
| `oui refire T4` | `oui retry T4`: send a ticket back to its cook |
| `oui 86 T4` | `oui cancel T4`: take a ticket off the board |
| `oui service off` | nothing new is fired; turns in progress finish |

## Where cooks run

Oui Chef is Herdr-first and not tied to Herdr. `sessions` in `~/.ouichef/config.json` says where a cook's session lives:

| `sessions` | Each cook is | What that gives you |
|---|---|---|
| `auto` (default) | `herdr` when herdr-core (`hc`) is installed, otherwise `none` | |
| `herdr` | a [herdr-core](https://github.com/herdrdev/herdr-core) terminal: one Herdr space per goal, one tab per ticket | watch any cook, type to it, peek at it from the board; Herdr's sidebar, sounds and toasts; terminals that outlive the window and the daemon |
| `tmux` | a window in one tmux session (`tmux attach -t oui`) | the same, in tmux |
| `none` | a headless process under the daemon | the board and `oui tail` |

In a terminal, a cook is an ordinary interactive agent session. Oui Chef does not read its screen to follow it. The agent's own hooks say when a tool is about to run (that is the pass) and when a turn ends, and answers are typed into the terminal. So you can step in at any time, with `oui takeover T4` or by clicking its tab, and type to the cook yourself. When it stops, the kitchen carries on from there.

Two things to know:

- A folder an agent has not seen makes it ask whether the folder is trusted. A cook's station is a worktree of a project you registered with `oui project add`, so Oui Chef answers that prompt for you. Register only projects you trust.
- Stopping the daemon leaves cooks in terminals running. Nothing risky gets past the pass while it is down, and the next `oui up` picks them up.

Another multiplexer is one file in `src/sessions/` with nine small functions: open a terminal, type into it, is it alive, close it, and so on. `herdr.mjs` and `tmux.mjs` are the examples.

## The pass

Every tool call a cook makes crosses the pass before it runs. For shell commands it reads the command the way a careful person would: through pipes, `&&`, `$(…)`, `bash -c`, `sudo`, `xargs` and `ssh host '…'`.

| Tier | What happens | Examples |
|---|---|---|
| **run** | Goes through. Not recorded. | tests, builds, `git commit`, `kubectl get`, `terraform plan`, anything inside the cook's station |
| **run + undo** | Goes through. Recorded in the ledger, with a checkpoint and the commands that put it back wherever one exists. | `git push` of a ticket branch, `kubectl apply` on staging, `helm upgrade` outside production, `gh workflow run ci.yml`, a write to a non-production database, a connected tool (MCP) that is not plainly read-only |
| **hold** | Stops at the pass. You get an ask with the command and its undo. On approval the cook is resumed and runs exactly that. | `gh pr merge`, anything in a production context or namespace, `kubectl delete namespace`, `terraform apply`, `npm publish`, `DROP TABLE`, `rm -rf` or any write outside the station, `curl … \| sh`, `make deploy` |
| **never** | Refused. | reading the chef's token, calling the chef's commands, talking to the daemon directly, changing the agent's own identity |

Before a recorded command runs, the pass saves what it is about to change: the live manifests for `kubectl apply`, the replica count for `kubectl scale`, the release revision for `helm upgrade`, the remote commit for `git push`. `oui undo` turns that into commands.

```bash
oui policy rules                          # every rule, its tier, and what it means
oui policy set forge.pr.merge record      # e.g. let cooks merge pull requests, recorded with an undo
oui policy set kube.change hold           # or be asked even for staging
```

`~/.ouichef/policy.json` holds your overrides, what counts as production (`prod.words`, `prod.contexts`, `prod.namespaces`, `prod.hosts`), which clusters are always scratch space (`safe.contexts`), your protected branches, and `allow` / `hold` / `deny` patterns for whole commands.

**What the pass is not.** It is a seatbelt, not a sandbox. It catches what an eager agent does in plain sight, and it is tested against a long list of real commands. It cannot see inside a script it has not read, and an agent determined to hide what it does from the same user account could. It holds scripts whose names say deploy, release, migrate or destroy for that reason. Some undo recipes are honest about their limits: a deleted volume's data does not come back, a published package stays published, a cancelled pipeline does not undo what it already did.

## The board in Herdr

```bash
oui mod install       # copies the mod to ~/.config/herdr-app/mods/ouichef
```

Then, in [Herdr](https://herdr.dev):

```bash
herdr-app check ~/.config/herdr-app/mods/ouichef
herdr-app do pane.split --direction right --mod ouichef
```

The mod is a 360px panel in your Herdr theme: the pass on top, each ask with its buttons and a field to type an answer or a note, then running, next up, waiting, done and the latest messages. A new ask posts a Herdr toast and plays the needs-you sound. Clicking a ticket peeks at its cook's live terminal. The header button opens a tab with every goal as a lane and connectors for what waits on what. See [`herdr/ouichef/RECIPE.md`](herdr/ouichef/RECIPE.md).

The mod has not been run inside Herdr yet; see "What was and was not verified" below. If `herdr-app check` reports a problem, give the agent in Herdr the recipe: it lists the five places a difference is most likely.

The same board is always available in a browser at the address `oui up` prints.

## Make it yours

Oui Chef does not prescribe a way of working. The mechanics are code: order, the pass, checks, merging. How a goal is talked through, how tickets are cut and what a reviewer looks for are words in four plain files. They are a starting point that works, and they are meant to be changed.

| File | What it steers |
|---|---|
| `sous.md` | The sous chef you talk to in `oui sous`: what it asks before planning, how much, and when it stops asking |
| `tickets.md` | How tickets are cut and briefed. The sous chef and the planner behind `oui go` both follow it |
| `roles.md` | The planner, the triage of cooks' questions and the inspector, one section each |
| `cook.md` | What every cook is told |

```bash
oui prompts                 # each file, what it steers, and which copy is in use
oui prompts copy tickets    # start your own copy in ~/.ouichef/prompts
```

Your copy wins over the built-in one, and an edit is used from the next conversation, plan, review or cook on, with no restart. In your `roles.md`, keep only the sections you change; the others stay built-in. Delete a file to go back to the default.

Some ways to run a kitchen:

- **No questions.** In `sous.md`, have the sous chef decide everything itself and list what it assumed.
- **A long talk before every goal.** Have it keep asking until you say to cook.
- **House rules for tickets** in `tickets.md`: one ticket per pull request, a failing test first, a design note before any code.
- **A stricter inspector.** Add your standards to the `review` section of `roles.md`.

For one lasting preference you do not need a file: `oui remember "skip the questions on small goals"` reaches the sous chef, the planner and every cook.

### More than one inspector

Out of the box one inspector reads each finished build ticket against its brief. Any section in your `roles.md` headed `review: <name>` is one more. Each reads the work separately, at the same time, so one concern cannot crowd out another. A ticket merges when none of them wants changes; otherwise the cook gets every inspector's notes in one go.

```markdown
## review: standards

You check one thing in ticket {{ticket}}: that the change follows this project's CONTRIBUTING.md.
Read it, then read `git diff {{base}}...{{branch}}` in `{{workdir}}`. You do not edit files.

- `oui verdict {{ticket}} pass --notes "<what you checked>"`
- `oui verdict {{ticket}} changes --notes "<the rule, and where the change breaks it>"`
```

A section can use what the built-in one uses: `{{ticket}}`, `{{title}}`, `{{brief}}`, `{{accept}}`, `{{decisions}}`, `{{summary}}`, `{{evidence}}`, `{{actions}}`, `{{branch}}`, `{{base}}`, `{{workdir}}`, `{{checks}}`. It must end in one `oui verdict`. `oui prompts` lists the inspectors in use. To change what the built-in one looks for, write your own `## review` section.

Words in double braces, such as `{{detail}}` and `{{tickets}}`, are filled in by Oui Chef; keep the ones you want. Agents cannot rewrite what they are told: the pass refuses any attempt to touch your copies.

## Configuration

`~/.ouichef/config.json` (all optional):

| Key | Default | Meaning |
|---|---|---|
| `port` | `7330` | Where the daemon listens, on 127.0.0.1 only |
| `sessions` | `auto` | Where cooks run: `auto`, `herdr`, `tmux` or `none` (see above) |
| `maxCooks` | `3` | Cooks running at once, across all projects |
| `model`, `sousModel` | harness default | Model for cooks, and for the judgement calls: the planner, triage and the inspectors |
| `effort`, `sousEffort` | harness default | How hard they think: `low`, `medium`, `high`, `xhigh` or `max` |
| `calls.plan` / `calls.triage` / `calls.review` | `true` | `false` turns a judgement call off. An object tunes that one call: `{ "model": …, "effort": …, "timeoutMinutes": … }` |
| `roleTimeoutMinutes` | `10` | A judgement call longer than this is stopped |
| `maxAttempts` | `3` | Times a ticket is sent back before you are asked |
| `turnTimeoutMinutes` | `120` | A cook's turn longer than this is stopped |
| `budgetUsdPerTurn` | none | Spending limit per cook turn |

Judgement calls run with your agent's own defaults unless you say otherwise, so a default set for long work makes every plan and review slow. To give the planner room and keep the short calls quick:

```json
{
  "sousEffort": "medium",
  "calls": {
    "plan": { "timeoutMinutes": 20 },
    "triage": { "effort": "low" },
    "review: security": { "model": "opus", "effort": "high" }
  }
}
```

An inspector of your own (`review: security`) starts from what `review` says and can differ from it; `false` switches that one off. If the planner runs out of time or stops without a plan, nothing is guessed: an ask on the pass offers to plan it again (with twice the time, if time was the problem), run the goal as one ticket, or cancel it.

Per project (`oui project add <path> --landing local|pr --merge ask|auto --plan auto|ask --verify "npm test"`): how goals land, whether landing asks you, whether you see each plan before it starts, and checks every ticket must pass.

`oui remember "always squash-merge"` saves a standing preference. Every cook, every plan and the sous chef you talk to get it.

Set `OUI_HOME` to keep a second, separate kitchen.

## What was and was not verified

Verified, with real runs:

- **The whole loop with real Claude Code agents**, on a scratch repository: a cook edited and committed, was held at the pass on a production `kubectl apply`, ended its turn, was resumed after approval, ran the command and reported; an inspector reviewed the diff read-only and passed it; the work was merged and landed. A real sous chef planned a one-sentence goal into ordered tickets.
- **Cooks in terminals**, with a real Claude Code cook in a tmux window: the terminal was opened, the trust prompt answered, the production command held at the pass, the approval typed into the terminal, the report filed, and the inspector's send-back typed in.
- **38 automated tests**, run on Linux (including with the temp folder behind a symlink, as it is on macOS): the dependency graph; the pass against about 200 commands and tool calls; every prompt rendered with nothing left blank; and the full loop with scripted cooks through the real hooks, CLI and git, including denial, a cook trying to approve itself, a cook that goes silent, failed checks, mid-plan landing, undo, the daemon's access rules, and both session backends (tmux for real, Herdr against a stand-in `hc` that records every call).
- **The web board** in Chromium: dark, light and phone width; answering, approving and firing a goal from the page.
- **Questions as tickets, and your own prompts**, on macOS. Automated: a `decide` ticket reaches the pass while every cook is busy, holds only the tickets that need it, and its answer is in the brief of the cook behind it; your own prompt files win over the built-in ones, one file or one role at a time; the pass refuses an agent that touches them. With real Claude Code, once each on a scratch repository: the planner turned "add rate limiting" into two tickets that started at once, two questions on the pass, and one last ticket waiting for both answers; it turned a small, clear goal into a single ticket with no question; and the sous chef, given a one-sentence goal, read the repository, asked one numbered round of three questions with its own answer to each, and planned nothing.

- **Seeing the plan first, tuned judgement calls, more than one inspector**, on macOS. Automated: a plan waits on the pass, goes back with your words and starts on your go; a sous chef who runs out of time or writes no plan asks instead of guessing; an inspector of your own reads the work separately and sends it back; the effort you set reaches the agent's command line. With real Claude Code, once: at `medium` effort with the plan check on, the planner planned "add rate limiting" in one minute, and its plan waited on the pass with a note on how it cut the work and what it assumed. The same goal had taken 6.8 minutes at the agent's default effort, on an earlier and longer version of the ticket rules, so the two are not a like-for-like comparison.

Not verified:

- **Anything inside real Herdr.** Herdr and herdr-core could not be run where this was built. The `herdr` sessions backend uses only documented `hc` commands (`run`, `send`, `get`, `kill`, `rm`, `read`, `keys`, `interrupt`), and is tested against a stand-in. Whether a goal's cooks land in one space as named tabs exactly as intended is unconfirmed. The mod is written against Herdr's published guide and type file and tested with Herdr's modules replaced by stand-ins; how Herdr draws it is unconfirmed.
- **Real clusters and forges.** `kubectl`, `helm` and `gh` were stand-ins. The checkpoint and undo commands are the documented ones; they have not been run against a live cluster.
- **`landing: pr`** (push and `gh pr create`), **`oui sous`** and **`oui takeover`** (interactive sessions) were not exercised end to end. Of a conversation with the sous chef, only its first reply was seen.
- **A real inspector of your own, and a real plan sent back.** Both run in the tests with scripted agents only.
- **A real cook working from a decision.** The tests show the answer in the cook's brief; no real cook has built on one yet. The `decide` ticket on the web board and in the Herdr panel was not looked at.
- **Other agent CLIs.** Cooks are Claude Code. `src/harness/` is the one place to add another.

## Layout

```
bin/oui.mjs                the command
src/kitchen.mjs            all state and the rules for changing it
src/expediter.mjs          fires, supervises, reviews, merges, lands
src/guard/                 the pass: the command reader, the rules, checkpoints and undo
src/sessions/              where cooks run: herdr-core, tmux (headless needs none)
src/harness/               Claude Code as cook; scripted stand-ins for tests and the demo
src/server.mjs             the loopback API
src/board.mjs              the snapshot both boards draw
prompts/                   what cooks, the sous chef and the inspector are told (the built-in copies)
web/index.html             the board in a browser
herdr/ouichef/             the Herdr mod and its recipe
test/                      npm test
```

State is in `~/.ouichef`: `state.json`, `events.jsonl` (who said what), `ledger.jsonl` (what was changed, with undo), `tickets/<id>/` (brief, report, activity, checkpoints), and `prompts/` (your own copies of what agents are told, if you made any).

## Credits

The idea of one agent you talk to and workers it runs for you, and of waking a supervisor only when something needs it, comes from [firstmate](https://github.com/kunchenguid/firstmate). "Decisions, not supervision", asks that end a turn, and standing preferences come from [obeya](https://github.com/sadilek/obeya). The mod's structure follows [Agenttrail's](https://github.com/sodiumsun/agenttrail). The pass, the undo ledger, the dependency-ordered expediter and landing per goal are this project's own.

Oui Chef is not affiliated with any restaurant, guide or chef.

## License

MIT. See [LICENSE](LICENSE).
