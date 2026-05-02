# Gemini-2 Studio

Gemini-2 Studio is a chat-first desktop-shell MVP for the local Gemini-2 fork.

It is intentionally thin:

- the backend uses `@google/gemini-cli-sdk` sessions for real prompt streaming
- the UI exposes simple controls for model, effort, loop mode, and runtime
  activity
- the surface is designed to reduce CLI command recall for daily use

## Run

From the monorepo root:

```bash
npm run build --workspace @google/gemini-cli-desktop-shell
npm run start --workspace @google/gemini-cli-desktop-shell
```

Then open:

```text
http://127.0.0.1:43137
```

## Current scope

This MVP already supports:

- normal chat prompts
- model switching
- effort presets
- loop start / loop autorun / loop stop
- runtime tape for tools, skills, agents, and loop activity

The current MVP does not yet package itself as Electron or Tauri; it is a local
GUI shell served from Node so the runtime path stays simple while the product
surface matures.
