# Getting started

From nothing to your first goal landed, in five steps. Each step works without the ones after it, so stop wherever you like.

## Before you start

- **Node 20 or newer** and **git**.
- **Claude Code**, logged in. Run `claude` once in any folder and get past its first-run screens.
- Optional, used when present: **Herdr** with herdr-core (`hc`) so cooks appear as live terminals, **tmux** for the same without Herdr, and whatever your work needs (`gh`, `kubectl`, `helm`).

## 1. Install

```bash
git clone https://github.com/alakiani/oui.git
cd oui
npm link
```

`oui help` should now print the command list. Nothing else is installed and nothing runs yet. To check your machine first, `npm test` runs the whole suite in under a minute.

## 2. Watch a service that touches nothing real

```bash
oui demo
```

It prints an address; open it. This is a throwaway kitchen: a scratch repository, scripted stand-in cooks, and a fake `kubectl` and `gh` that only print. In a minute or two you will see everything Oui Chef does:

1. Three goals appear as lanes. Tickets that need nothing start; the rest show what they wait for.
2. A **question** lands on the pass: how should rate limits be counted? It came from a cook, through the sous chef, who reworded it and marked a suggestion. Click an option. The three tickets behind it start in order.
3. An **access request** lands: a cook says exactly what it is missing and the command that fixes it. Click *Done*.
4. A staging rollout runs without asking. Then the production rollout is **held**: you see the exact command and how it would be undone. Type a note if you like, and *Approve*.
5. When a goal's tickets are all done: **Land it?** One decision per goal.

The same from a terminal, while the demo runs. It prints the `export` line to use:

```bash
oui status
```

```bash
oui answer A1 2
```

```bash
oui actions
```

`oui answer A1 2` picks the second option. `oui actions` lists everything that changed something outside a cook's own folder, each with its undo. Ctrl-C stops the demo and removes its folder.

## 3. Your first real goal

Pick a small repository and a small goal. The first time, run cooks headless: it is the simplest path and there is less to look at.

```bash
mkdir -p ~/.ouichef && [ -e ~/.ouichef/config.json ] || echo '{ "sessions": "none" }' > ~/.ouichef/config.json
```

That writes the file only if you have none. If you already have one, add `"sessions": "none"` to it yourself. The config is read when Oui Chef starts, so if it is already up, run `oui down` first.

```bash
oui up
```

Open the address it prints. That is your board from now on. Register the repository:

```bash
oui project add ~/code/my-repo --landing local --verify "npm test"
```

- `--landing local` means nothing is pushed anywhere. Finished work reaches your base branch only when you approve the landing, as a local fast-forward.
- `--verify` is a command every ticket must pass before it counts as done. Leave it out if you have none.
- The base branch is whichever branch is checked out when you add the project.

Cooks never work in your checkout. Each gets its own git worktree under `~/.ouichef/worktrees`, so you can keep working in the repository meanwhile.

Hand over the goal, in your own words:

```bash
oui go "Add a --version flag to the CLI that prints the version from package.json, with a test"
```

Now watch the board, or `oui status`. The sous chef reads the repository and writes the tickets. Cooks start. From here you only do three things:

- **Answer** what lands on the pass, on the board or with `oui answer A1` (it shows the question and takes a number or your own words).
- **Approve or deny** held commands: `oui approve A2 --note "go ahead"`, `oui deny A2 --note "not today"`.
- **Land** the goal when it asks.

Then look at what you got:

```bash
git -C ~/code/my-repo log --oneline -5
```

Not happy with it? Landing is recorded like every other action:

```bash
oui actions
```

```bash
oui undo X4 --yes
```

Use the number `oui actions` shows for the landing. Without `--yes`, `oui undo` only shows what it would run. It moves the base branch back and leaves your own uncommitted edits alone; if they are in the way, git refuses and nothing changes.

To talk a goal through before any ticket exists, use `oui sous` instead of `oui go`. It opens a conversation with the sous chef, who reads the repository and then asks you what only you can settle, a round at a time: numbered questions, each with the answer it would give. Reply "yes to all", or "2: per IP, the rest yes". Say "cook it" whenever you have heard enough.

The plan it then writes is held: the tickets are on the board, and no cook starts. The sous chef calls the plan back to you in a few lines, says where it is least sure, and changes it until you both agree. It starts when you say so, there or with *Cook it* on the pass.

A question does not have to hold everything up. When only part of a plan depends on it, the sous chef can put it on the pass as a ticket of its own: the tickets that need your answer wait, and the rest start cooking.

Somewhere between the two: hand the goal over, and look at the plan before it starts.

```bash
oui go "Add a --version flag to the CLI, with a test" --plan ask
```

The plan arrives on the pass as one ask, with the tickets and what the sous chef assumed. *Cook it* starts it. Typing what you would change sends it back to be planned again. `oui project add <path> --plan ask` does this for every goal in a project.

## 4. Tell it what production is, before any cluster work

The pass holds anything in production for your approval. It recognises production by name: a kube context, namespace or host with the word `prod`, `production`, `prd` or `live` in it (`acme-prod-eu` counts, `product` does not). Check yours:

```bash
kubectl config get-contexts
```

If your production cluster is called something else, say so in `~/.ouichef/policy.json`:

```json
{
  "prod": { "contexts": ["my-main-cluster"], "namespaces": ["payments"] }
}
```

This takes effect on the very next command a cook runs; no restart.

`oui policy rules` lists every rule and what it does today. To move one:

```bash
oui policy set forge.pr.merge record
```

That example lets cooks merge pull requests without asking, recorded with an undo. `hold` makes a rule ask first; `default` puts it back.

Standing preferences go in once and reach every cook and every plan:

```bash
oui remember "Always squash-merge. Never touch the billing service without asking."
```

## 5. Turn on Herdr

With herdr-core installed, cooks can run as real terminals in Herdr: one space per goal, one tab per ticket. You can watch any cook and type to it.

Remove the `sessions` line from `~/.ouichef/config.json` (or set it to `"auto"`), then restart:

```bash
oui down && oui up
```

Add the board to Herdr:

```bash
oui mod install
```

```bash
herdr-app check ~/.config/herdr-app/mods/ouichef
```

```bash
herdr-app do pane.split --direction right --mod ouichef
```

The panel shows the pass with a field under each ask, posts a Herdr toast when something new arrives, and peeks at a cook's terminal when you click its ticket.

This is the newest part and the one not yet proven inside real Herdr. If cooks do not show up as expected, these three say why:

```bash
oui tail T1
```

```bash
hc ls
```

```bash
herdr-app status
```

Prefer tmux? Set `"sessions": "tmux"` and look in with `tmux attach -t oui`.

## Make it yours

Everything above is how Oui Chef works out of the box, not how it has to work. What the sous chef asks, how tickets are cut and what the inspector looks for are plain text files:

```bash
oui prompts
```

That lists them, says what each one steers and which copy is in use. To change one, make it yours and edit it:

```bash
oui prompts copy sous
```

Your copy lives in `~/.ouichef/prompts` and wins over the built-in one. The next conversation, plan, review or cook uses it; nothing needs restarting. Delete the file to go back.

One inspector reads each finished ticket against its brief. To add another, with its own concern (your coding standards, security, naming), write a section headed `## review: <name>` in your `roles.md`. The README shows one.

## Day to day

| You want to | Run |
|---|---|
| See what needs you | `oui status`, or the board |
| Hand over a goal | `oui go "…"` |
| Say go to a plan that is waiting for you | `oui cook G2`, or *Cook it* on the pass |
| Watch one cook | `oui tail T3 -f` |
| Step in and type to a cook | `oui takeover T3` |
| Send a ticket back with guidance | `oui refire T3 --note "use the existing helper"` |
| Drop a ticket | `oui 86 T3` |
| Stop anything new from starting | `oui service off` |
| See what was changed, and undo it | `oui actions`, `oui undo X7 --yes` |
| Stop everything | `oui down` |

## When something goes wrong

- **A ticket failed or went quiet.** It is on the pass with *Retry*, *Accept as done* and *Cancel ticket*. `oui tail T3` shows what it did. Typing your own words instead of clicking an option retries it with that as guidance.
- **A cook keeps asking for something you already settled.** Say it once for good with `oui remember`.
- **The sous chef asks too much, or too little.** `oui remember "skip the questions on small goals"`, or edit your copy of `sous.md` (see Make it yours).
- **Planning or reviewing takes minutes.** They run with your agent's default model and effort. Set `"sousEffort": "medium"` in `~/.ouichef/config.json`, or tune one call: `"calls": { "plan": { "effort": "medium", "timeoutMinutes": 20 } }`. Restart with `oui down && oui up`.
- **A goal says it has no plan.** The sous chef ran out of time or stopped without one. The ask on the pass lets you plan it again, run the goal as a single ticket, or cancel it.
- **Something was held that you never want to be asked about.** `oui approve A5 --always` for that exact command, or `oui policy set <rule> record` for the whole rule.
- **The daemon will not start, or behaves oddly.** Read `~/.ouichef/daemon.log`.
- **Start over.** `oui down`, then delete `~/.ouichef`. In each repository, `git worktree prune` and delete the `oui/…` branches you no longer want.
