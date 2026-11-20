# Guided Build implementation plan

## Goal

Add an optional Guided Build workflow to KAI Desktop. You choose a Coach to plan and review one step at a time. You can make the edit yourself in KAI's editor or pass an editable instruction to your chosen Builder and watch the files change.

## What it looks like in KAI

| Screen | Placement and action |
| --- | --- |
| Workspace | Add a **Guided Build** switch near the conversation header. When enabled, open a collapsible Coach panel using the existing Workspace side panel layout. Keep the conversation, editor, composer and terminal in their usual places. |
| Project Studio | Add **Start building** to the existing **Senior dev** tab. Preview the selected plan or card, then open its project in Workspace with Guided Build enabled. |
| Learn & Code | Extend **Senior dev** alongside the file editor. Show the same active step, exact edit location and review result. Keep the existing Learn and Review tabs available. |

Use KAI's `ui/Toggle.tsx` for **Guided Build** and **Follow Builder edits**. Use `OptionMenu` for a compact Workspace header or toolbar menu, matching the existing Access, Task and Model menus. Use `ui/Select.tsx` for labeled dropdowns inside the Coach panel. Use `UiButton`, existing panel and tab styles, and the theme tokens in `design-system.css`. Keep labels visible, preserve keyboard focus when opening or closing dropdowns, and use the existing narrow window layout patterns.

The Coach panel offers four independent choices. These labels and defaults are proposed for the first version.

| Control | Options | Suggested default |
| --- | --- | --- |
| Coach agent and model | Configured compatible agents and models, such as Codex or Claude | Choose on first use |
| Coach style | Tutor, Senior Dev | Tutor |
| Detail | Brief, Step by step, Line by line | Step by step |
| Ask questions | Only when blocked, Before major decisions, At each step | Only when blocked |

Tutor explains the code and why the change improves it. Senior Dev gives direct instructions and review feedback. Both can name exact files, functions and fields and show what to change. Question frequency is independent of style and detail.

## Implementation order

1. **Add session state and scope.** Use `packages/contracts/src` and the existing main-process persistence and IPC patterns. Store the project and conversation IDs, plan revision, current step, Coach settings and review state. A step includes its purpose, file and symbol anchors, editable instructions, optional code snippet and acceptance criteria. Older conversations open with Guided Build off. Switching it off hides the panel and preserves progress. Switching projects cannot show or run another project's step.
2. **Add the Workspace controls.** Use `App.tsx` and `components/Workspace.tsx` plus the shared controls above. Opening or closing Guided Build preserves the Builder's current agent/model, route, access, task mode, helper choices and draft. Label the Coach and Builder separately so it is clear which model receives each request. Coach settings apply only to the guided session. Resolve unavailable Coach connections visibly before a run.
3. **Generate and display a plan.** Run the selected Coach with project read access using the existing agent routing. Capture a structured, editable plan and show the current step with **Why**, **Where**, **What to change**, and **Done when**. File links jump to verified locations via Workspace's `openWorkspaceFile` pattern. If an anchor cannot be found or code has moved, show that and refresh the location before proposing a specific edit. Approving a plan does not run a Builder.
4. **Wire the two ways to edit.** **Edit myself** opens the file and location in KAI's editor. **Use Builder** puts the current step into the existing composer as an editable draft, with the current Builder settings. Confirm before replacing a nonempty draft or let the user append. Only the normal Send action runs the Builder. Record the step and revision associated with that run; keep unrelated composer work independent.
5. **Follow Builder edits in the editor.** Reuse the Workspace file preview and existing `file.edit.applied` / `file.change` events. Filter by the active guided run and project and highlight changed lines where available. Provide a toggle and manual file selection. Pause automatic jumps while the user is typing or a buffer is unsaved. Open the planned file before execution when available, then refresh after each reported edit. Adapters that only report the final diff should open files after the run and say so. **Risk to check early:** event timing varies by adapter. Trace a local API Builder and a CLI Builder before committing to live behavior across both. This is the first technical investigation to run alongside task 1.
6. **Review against real edits.** Reuse the existing change and review pipeline as a starting point (`main/change-review.ts`, `turn.changes`, Workspace review). **Review step** collects saved edits from either route, displays the code and check evidence, and asks the selected Coach to compare it with the step's criteria. Show **Ready to continue**, **Changes needed**, or **Could not verify**, with specific file and line feedback. Checks respect the existing execution permissions. Keep the current step open after a failed or incomplete review. Advance with **Next step** after a passing review. Changes to the step or reviewed files invalidate that review.
7. **Connect Studio and Learn & Code.** Add the Studio action to `StudioView.tsx` / `GuidePanel` using the existing Studio-to-Workspace launch pattern in `App.tsx`. Start a linked Workspace session with the selected plan revision and no automatic Builder send. Add the guided step and review actions to the existing `CodeView.tsx` / `CodeGuidePanel` Senior dev tab. Both screens resolve the same session and show the same progress after switching views or reopening KAI.

Tasks 2–6 build on the session contract in order. Task 7 uses the working Workspace loop. The first release covers one step at a time and a manual handoff and review. Coach plans and reviews are explicit actions, so using a stronger model does not add a paid call for every Builder edit.

## Acceptance walkthrough

- Start in Workspace with a chosen local Builder and an existing draft. Toggle Guided Build on and off, switch Coach styles, and confirm the Builder's settings and draft are intact.
- Start from Studio Senior dev and confirm that the right project and plan open in Workspace. Edit the proposed task, load it into the composer, and use the existing Send button.
- Make one step manually. Run another using a local Builder. Confirm the editor opens at the intended location, follows supported edit events, and leaves an unsaved buffer alone.
- Review a correct edit and an incomplete one. Confirm the Coach points to actual code, distinguishes checks that did and did not run, and only offers **Next step** after a passing review.
- Resume the same step in Learn & Code and after restart. Check dropdown keyboard interaction, focus, visibility in supported themes, and a narrow window.

## References

- `components/Workspace.tsx:2304` for the existing side conversation and `:2440` for composer menus.
- `App.tsx:437` for file opening and dirty-buffer handling, and `:1291` for the Studio launch pattern.
- `components/StudioView.tsx:2833` and `components/CodeView.tsx:2301` for the existing tab strips.
- `packages/contracts/src/events.ts:77` and `:179` for applied edits and turn changes. Adapter timing still needs to be measured as part of implementation.
