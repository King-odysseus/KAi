# KAI 1.2.38

## Guided Build, rebuilt around one chat

- Guided Build is a conversation, not a form. The Coach's words, the file and the checks sit in the chat with buttons: Do it for me, Show me the code, I'll edit it myself. A progress strip replaces the old step fields, which are still there under Edit this step.
- Workspace, Learn & Code and Project Studio now share one engine and one card. Learn & Code adds Walk me through it, Quiz me and Explain simpler.
- The Builder defaults to a model on your computer or network, and a stronger model plans and checks. A step that rests on a risky assumption from a Studio brief waits for your OK before anything is built.
- Checking a step is real: KAI asks before running the project's own check, reads the actual diff (including files you edited by hand), and the Coach cannot pass a step while that check fails.
- A local Builder works one small step at a time with a round limit. If it gets stuck, the card offers a retry on the Coach's stronger model for that step only.
- Plan and team panel: the hands-on dial, who plans and builds, the stuck setting, a check of the Builder's model against its own server, a count of requests actually sent, and a saved Model team used as the starting point for new plans, Architect runs and crews.
- Project Studio's narrator is now called Project guide, and "Start in Workspace" carries the brief into the plan.

## Crew

- Model ladder: a card a local builder cannot finish in two attempts goes to a stronger model, that card only; the next card starts local again. It is on by default and can be turned off.
- Local builders get the start of the files their card names attached, so they do not spend their turn searching.
- A savings strip and a badge on each card show how much of the building stayed on your own models. The estimate is taken from the run's own paid builds, never a price list.
- The "skip a second review" switch now works: work that is identical to what was last reviewed is sent back without paying for another review.
- A question about a task that was later accepted no longer leaves the run stuck on "needs you".

## Version and use

- Desktop version: 1.2.38 (patch release; no breaking changes).
- Saved conversations and crews gain a few optional fields. Older builds may not read conversations or crews saved by this one.
- Restart KAI after installing the updated desktop build.
- Roll back by installing the prior 1.2.37 build.

## Known

- `test/desktop-learning.test.ts` "repairs one malformed tutor response" fails on the previous commit as well; it is not part of this release.
- The new Plan and team panel and Guided Build card were checked by typecheck and tests, and have not been looked at in the running app before this release.
