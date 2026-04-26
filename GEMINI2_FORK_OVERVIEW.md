# Gemini-2 Fork Overview

This fork keeps the official `google-gemini/gemini-cli` codebase as its
architectural base while adding a thicker local engineering runtime aimed at
long-running project work.

## What this fork adds

- Shared-fabric-aware launcher flow with canonical boot integration
- Shared-fabric skill registry, discovery, and explicit command surface
- Automatic session context seeding from global profile, runtime map, and
  workspace overlay
- Conservative automatic skill activation and agent hint routing
- Query runtime inspection and bridge snapshot export
- Team memory visibility and explicit subagent task entrypoints
- Canonical shared-fabric postflight write-back through `/fabric sync`

## Design principle

The goal is not to replace Gemini CLI with a Claude-Code-style monolith. The
goal is to preserve Gemini CLI's package boundaries and upstream syncability,
while grafting in selected workflow-runtime ideas:

- clearer session orchestration
- visible context and memory management
- dynamic skill loading
- explicit delegation seams
- stronger project-scoped runtime behavior

## Key files

- `packages/cli/src/core/sessionOrchestrator.ts`
- `packages/cli/src/services/sharedFabricRegistry.ts`
- `packages/cli/src/services/sharedFabricAutoRouter.ts`
- `packages/cli/src/services/queryRuntimeService.ts`
- `packages/cli/src/ui/commands/fabricCommand.ts`
- `packages/cli/src/ui/commands/runtimeCommand.ts`
- `packages/cli/src/ui/commands/skillsCommand.ts`
- `packages/cli/src/ui/commands/agentsCommand.ts`
- `packages/cli/src/ui/commands/memoryCommand.ts`

## Current boundary

This fork already provides a stronger project runtime than upstream Gemini CLI,
but it is still intentionally Gemini-first. It does not attempt to fully clone
Claude Code's daemon model or autonomous subagent runtime.
