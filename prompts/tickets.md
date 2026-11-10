- **A ticket is a dish, not an ingredient.** It delivers something a person can try or a command can check, through every layer it touches (data, logic, interface, tests). "Add the schema", "add the endpoint" and "add the screen" are ingredients: nothing can be tasted until all three are done. Cut by behaviour instead: first the thinnest version that works from end to end, then one ticket for each thing added to it.
- **One cook, one sitting.** A ticket is as much as one cook can hold in their head and finish. Split where work can run in parallel, or where one failure should not sink the rest. A small goal is one ticket: do not invent steps.
- **Prep comes first.** When the code needs reshaping before the change is easy, the reshaping is its own ticket, ahead of the change.
- **A change that touches everything at once** (a rename, a new shape for something shared) cannot be served as one dish. Add the new form beside the old one. Move the callers over in batches, one ticket each. Remove the old form last, in a ticket that needs every batch. The checks pass after each ticket.
- `needs` is a real dependency: this ticket cannot start, or would be wasted, until that one is finished. Leave it out when two tickets merely touch nearby code; the expediter merges finished work into the goal's branch and the later cook resolves any conflict.
- **The brief is all the cook gets**, along with the goal, the chef's preferences, the decisions made for this goal and the handoff notes of what it needs. Write it for someone who was not in this conversation:
  - what is true today, and what should be true when the ticket is done, edge cases included;
  - where to look, and anything you learned that would save them an hour. Describe behaviour and interfaces rather than lines to edit: other tickets change the same code while this one waits;
  - what is out of scope. A cook told only what to build will also tidy what is nearby.

  Keep it in proportion to the work. Say what the cook could not find out in a minute, and leave out what the first file they open will tell them. A small ticket gets a few lines, not a page.
- `accept` is how the inspector decides the ticket is done. Each item can be observed or run, and can be checked without the others.
- `kind` says who does the ticket:
  - `build` changes code in its own worktree.
  - `ops` acts on systems (clusters, pipelines, deploys) and has the goal's code.
  - `scout` investigates and reports without changing anything.
  - `decide` is a question for the chef, and has no cook. `title` is the question in one line, `brief` says what depends on it, `options` are the choices and `pick` is the one you would make. It reaches the pass as soon as what it `needs` is finished, and the answer is given to every cook in the goal that starts afterwards. Tickets that cannot start without the answer `needs` it. Everything else carries on meanwhile.
  - `land` has no cook either: it lands everything finished so far on the base branch, with the chef's approval.
- Finished tickets merge into a branch for the goal, not into the base branch. Later tickets start from that branch, so they see earlier work, and the goal lands once, at the end, when the chef approves. If a step must run from the base branch (a pipeline that deploys from it, a production rollout), put a `land` ticket before it instead of writing "after this is on main" in a brief.
