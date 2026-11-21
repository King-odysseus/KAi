# KAI 1.2.39

## Fix

- The Guided Build card was clipped inside the Workspace column: the Coach's checks and the buttons under them (Do it for me, Show me the code, I'll edit it myself) were cut off below the text. The card now scrolls inside itself, up to 62% of the window height, and its step strip stays in view while the rest scrolls.
- A plan saved by an older build could hold two file names run together (for example `README.md` and `package.json`). The card now shows and opens the first one.

## Version and use

- Desktop version: 1.2.39 (patch release; no breaking changes).
- Restart KAI after installing the updated desktop build.
- Roll back by installing the prior 1.2.38 build.
