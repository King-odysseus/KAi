# KAI Agent Workbench Vision

KAI is a VS Code-native multi-agent coding workbench.

The first product promise is simple: one place to direct real coding agents,
switch their model route, and keep durable Cognitive1 memory across the whole
task.

## What KAI Is

- A single VSIX extension.
- A unified workbench for Claude, Codex, Qwen Code, and Gemini CLI.
- A route-aware interface for Direct subscription usage or Proxy usage.
- A Cognitive1-backed memory surface for briefings, recalls, sessions, and
  handoffs.
- A safer command surface for Review, Auto, and Custom autonomy modes.

## What KAI Is Not

- Not a homemade generic LLM loop.
- Not a replacement for native agent harnesses.
- Not a place to store private brain data inside the extension install folder.
- Not a concurrent multi-agent editor where several agents write at once.

## MVP Shape

The MVP should prove the spine:

1. Open Agent Workbench inside VS Code.
2. Choose agent, route, and autonomy.
3. Start a task.
4. Stream normalized events into one timeline.
5. Show Cognitive1 session/recall events.
6. Track route and cost state.
7. Keep configs safe through backup and merge.

Claude lands first. Codex follows quickly because it proves the multi-agent
promise. Qwen Code and Gemini CLI come through ACP once the event model is
stable.

