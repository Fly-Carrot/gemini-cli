/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@google/gemini-cli-core';
import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
  type SlashCommandActionReturn,
} from './types.js';
import { MessageType, type HistoryItemInfo } from '../types.js';
import { LoopRuntimeService } from '../../services/loopRuntimeService.js';
import { parseSlashCommand } from '../../utils/commands.js';
import {
  AutomationStrategyService,
  describeLoopMode,
  type LoopAutomationMode,
} from '../../services/automationStrategyService.js';

function getConfig(context: CommandContext): Config | null {
  return context.services.agentContext?.config ?? null;
}

function getWorkspaceRoot(context: CommandContext): string {
  const settingsWithWorkspace = context.services.settings as {
    workspace?: { path?: string };
  };
  return (
    settingsWithWorkspace.workspace?.path ||
    process.env['GEMINI2_SHARED_FABRIC_WORKSPACE'] ||
    process.cwd()
  );
}

function getLoopRuntimeService(
  context: CommandContext,
): LoopRuntimeService | null {
  const config = getConfig(context);
  if (!config) {
    return null;
  }

  return new LoopRuntimeService(config, getWorkspaceRoot(context));
}

function getAutomationStrategyService(
  context: CommandContext,
): AutomationStrategyService | null {
  const config = getConfig(context);
  return config ? new AutomationStrategyService(config) : null;
}

function isLoopMode(value: string): value is LoopAutomationMode {
  return value === 'off' || value === 'auto' || value === 'full';
}

function parseStartArgs(args: string): {
  goal: string;
  maxIterations?: number;
} {
  const trimmed = args.trim();
  const maxMatch = trimmed.match(/\s--max(?:-iterations)?=(\d+)\s*$/);
  if (!maxMatch) {
    return { goal: trimmed };
  }

  const goal = trimmed.slice(0, maxMatch.index).trim();
  return {
    goal,
    maxIterations: Number.parseInt(maxMatch[1], 10),
  };
}

async function prepareLoopRun(
  context: CommandContext,
  args: string,
): Promise<
  | {
      stateText: string;
      stateSecondaryText: string;
      prompt: string;
    }
  | SlashCommandActionReturn
> {
  const loopRuntime = getLoopRuntimeService(context);
  if (!loopRuntime) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    };
  }

  const { goal, maxIterations } = parseStartArgs(args);
  const snapshot = await loopRuntime.getSnapshot();
  const strategies = await getAutomationStrategyService(context)?.getState();
  const loopMode = strategies?.loopMode ?? 'off';

  if (goal) {
    const state = await loopRuntime.startLoop(goal, maxIterations, true);
    const next = await loopRuntime.beginIteration();
    return {
      stateText: `Started Gemini-2 ${loopMode} loop for "${state.goal}".`,
      stateSecondaryText: `Iteration ${next.state.iteration}/${next.state.maxIterations} is queued and will continue under ${loopMode} loop automation until completion, blockage, or the iteration limit.`,
      prompt: next.prompt,
    };
  }

  if (!snapshot.exists) {
    return {
      type: 'message',
      messageType: 'error',
      content:
        'Usage: /loop run <goal> [--max=12], or run /loop start <goal> first and then /loop run',
    };
  }

  if (snapshot.status === 'completed') {
    return {
      type: 'message',
      messageType: 'error',
      content:
        'The current loop is already completed. Start a new loop before using /loop run.',
    };
  }

  await loopRuntime.setAutoRunEnabled(true);
  const next = await loopRuntime.beginIteration({
    resume: snapshot.status === 'paused',
  });
  return {
    stateText: `Enabled Gemini-2 auto loop for "${next.state.goal}".`,
    stateSecondaryText: `Iteration ${next.state.iteration}/${next.state.maxIterations} is queued and future iterations will continue automatically when safe.`,
    prompt: next.prompt,
  };
}

async function statusAction(
  context: CommandContext,
): Promise<void | SlashCommandActionReturn> {
  const loopRuntime = getLoopRuntimeService(context);
  const strategyService = getAutomationStrategyService(context);
  if (!loopRuntime) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    };
  }

  const strategy = await strategyService?.getState();
  const snapshot = await loopRuntime.getSnapshot();
  const mode = strategy?.loopMode ?? 'off';
  if (!snapshot.exists) {
    context.ui.addItem({
      type: MessageType.INFO,
      text: `Loop mode: ${mode}.`,
      secondaryText: describeLoopMode(mode),
    } as HistoryItemInfo);
    context.ui.addItem({
      type: MessageType.INFO,
      text: 'No Gemini-2 loop is active for this project.',
      secondaryText:
        mode === 'off'
          ? 'Run /loop auto or /loop full to choose an automation policy, then /loop start <goal> or /loop run <goal>.'
          : 'Run /loop start <goal> to begin a long-horizon task under the current loop policy.',
    } as HistoryItemInfo);
    return;
  }

  context.ui.addItem({
    type: MessageType.INFO,
    text: `Loop mode ${mode} · ${snapshot.status}: iteration ${snapshot.iteration}/${snapshot.maxIterations ?? '?'}${snapshot.autoRunEnabled ? ' · autorun on' : ''}.`,
    secondaryText: snapshot.goal,
  } as HistoryItemInfo);
  context.ui.addItem({
    type: MessageType.INFO,
    text: `Loop state file: ${snapshot.statePath}`,
    secondaryText: snapshot.lastSummary
      ? `Last checkpoint: ${snapshot.lastSummary}`
      : snapshot.stopReason || 'No checkpoint summary recorded yet.',
  } as HistoryItemInfo);
}

async function modeAction(
  context: CommandContext,
  mode: LoopAutomationMode,
): Promise<void | SlashCommandActionReturn> {
  const strategyService = getAutomationStrategyService(context);
  const loopRuntime = getLoopRuntimeService(context);
  if (!strategyService || !loopRuntime) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    };
  }

  await strategyService.setLoopMode(mode);
  const snapshot = await loopRuntime.getSnapshot();
  if (snapshot.exists && snapshot.status !== 'completed') {
    await loopRuntime.setAutoRunEnabled(mode !== 'off');
  }

  context.ui.addItem({
    type: MessageType.INFO,
    text: `Loop automation set to ${mode}.`,
    secondaryText: describeLoopMode(mode),
  } as HistoryItemInfo);
}

async function startAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const loopRuntime = getLoopRuntimeService(context);
  if (!loopRuntime) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    };
  }

  const { goal, maxIterations } = parseStartArgs(args);
  if (!goal) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Usage: /loop start <goal> [--max=12]',
    };
  }

  const strategies = await getAutomationStrategyService(context)?.getState();
  const autoRunEnabled = (strategies?.loopMode ?? 'off') !== 'off';
  await loopRuntime.startLoop(goal, maxIterations, autoRunEnabled);
  const { state, prompt } = await loopRuntime.beginIteration();
  context.ui.addItem({
    type: MessageType.INFO,
    text: `Started Gemini-2 loop for "${state.goal}".`,
    secondaryText: autoRunEnabled
      ? `Iteration ${state.iteration}/${state.maxIterations} is being queued under ${strategies?.loopMode ?? 'off'} loop automation.`
      : `Iteration ${state.iteration}/${state.maxIterations} is being queued into the main conversation.`,
  } as HistoryItemInfo);

  return {
    type: 'submit_prompt',
    content: prompt,
  };
}

async function nextAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const loopRuntime = getLoopRuntimeService(context);
  if (!loopRuntime) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    };
  }

  const { state, prompt } = await loopRuntime.beginIteration({
    guidance: args.trim() || undefined,
  });
  context.ui.addItem({
    type: MessageType.INFO,
    text: `Queued loop iteration ${state.iteration}/${state.maxIterations}.`,
    secondaryText: state.goal,
  } as HistoryItemInfo);
  return {
    type: 'submit_prompt',
    content: prompt,
  };
}

async function resumeAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const loopRuntime = getLoopRuntimeService(context);
  if (!loopRuntime) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    };
  }

  const { state, prompt } = await loopRuntime.beginIteration({
    guidance: args.trim() || undefined,
    resume: true,
  });
  context.ui.addItem({
    type: MessageType.INFO,
    text: `Resumed loop at iteration ${state.iteration}/${state.maxIterations}.`,
    secondaryText: state.goal,
  } as HistoryItemInfo);
  return {
    type: 'submit_prompt',
    content: prompt,
  };
}

async function stopAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const loopRuntime = getLoopRuntimeService(context);
  if (!loopRuntime) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    };
  }

  const state = await loopRuntime.pauseLoop(args);
  context.ui.addItem({
    type: MessageType.INFO,
    text: `Paused Gemini-2 loop at iteration ${state.iteration}/${state.maxIterations}.`,
    secondaryText: state.stopReason,
  } as HistoryItemInfo);
}

async function runAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const prepared = await prepareLoopRun(context, args);
  if ('type' in prepared) {
    return prepared;
  }

  context.ui.addItem({
    type: MessageType.INFO,
    text: prepared.stateText,
    secondaryText: prepared.stateSecondaryText,
  } as HistoryItemInfo);

  return {
    type: 'submit_prompt',
    content: prepared.prompt,
  };
}

async function doneAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const loopRuntime = getLoopRuntimeService(context);
  if (!loopRuntime) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    };
  }

  const summary = args.trim();
  if (!summary) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Usage: /loop done <summary>',
    };
  }

  const state = await loopRuntime.completeLoop(summary);
  context.ui.addItem({
    type: MessageType.INFO,
    text: `Completed Gemini-2 loop after ${state.iteration} iterations.`,
    secondaryText: summary,
  } as HistoryItemInfo);
}

async function checkpointAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const loopRuntime = getLoopRuntimeService(context);
  if (!loopRuntime) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    };
  }

  const summary = args.trim();
  if (!summary) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Usage: /loop checkpoint <summary>',
    };
  }

  const state = await loopRuntime.recordSummary(summary);
  context.ui.addItem({
    type: MessageType.INFO,
    text: `Recorded loop checkpoint for iteration ${state.iteration}.`,
    secondaryText: summary,
  } as HistoryItemInfo);
}

export const loopCommand: SlashCommand = {
  name: 'loop',
  description:
    'Set loop automation or run a long-horizon Gemini-2 loop. Usage: /loop [off | auto | full | status | start | run | next | resume | stop | checkpoint | done]',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  subCommands: [
    {
      name: 'off',
      description: 'Turn loop automation off and keep loop progression manual.',
      kind: CommandKind.BUILT_IN,
      action: (context) => modeAction(context, 'off'),
    },
    {
      name: 'auto',
      description:
        'Enable semi-automatic loop mode with review checkpoints for risky turns.',
      kind: CommandKind.BUILT_IN,
      action: (context) => modeAction(context, 'auto'),
    },
    {
      name: 'full',
      description: 'Enable fully automatic loop mode for low-risk long tasks.',
      kind: CommandKind.BUILT_IN,
      action: (context) => modeAction(context, 'full'),
    },
    {
      name: 'status',
      description: 'Show loop status. Usage: /loop status',
      kind: CommandKind.BUILT_IN,
      action: statusAction,
    },
    {
      name: 'start',
      description:
        'Start a long-horizon loop. Usage: /loop start <goal> [--max=12]',
      kind: CommandKind.BUILT_IN,
      action: startAction,
    },
    {
      name: 'next',
      description:
        'Queue the next loop iteration. Usage: /loop next [guidance]',
      kind: CommandKind.BUILT_IN,
      action: nextAction,
    },
    {
      name: 'run',
      description:
        'Enable autorun and continue looping automatically. Usage: /loop run [goal] [--max=12]',
      kind: CommandKind.BUILT_IN,
      action: runAction,
    },
    {
      name: 'resume',
      description: 'Resume a paused loop. Usage: /loop resume [guidance]',
      kind: CommandKind.BUILT_IN,
      action: resumeAction,
    },
    {
      name: 'stop',
      altNames: ['pause'],
      description: 'Pause the active loop. Usage: /loop stop [reason]',
      kind: CommandKind.BUILT_IN,
      action: stopAction,
    },
    {
      name: 'checkpoint',
      description:
        'Record a loop checkpoint summary. Usage: /loop checkpoint <summary>',
      kind: CommandKind.BUILT_IN,
      action: checkpointAction,
    },
    {
      name: 'done',
      description: 'Mark the loop complete. Usage: /loop done <summary>',
      kind: CommandKind.BUILT_IN,
      action: doneAction,
    },
  ],
  action: async (context, args) => {
    const trimmedArgs = args.trim();
    if (isLoopMode(trimmedArgs)) {
      return modeAction(context, trimmedArgs);
    }
    if (trimmedArgs) {
      const parsed = parseSlashCommand(
        `/${trimmedArgs}`,
        loopCommand.subCommands!,
      );
      if (parsed.commandToExecute?.action) {
        return parsed.commandToExecute.action(context, parsed.args);
      }
    }
    return statusAction(context);
  },
};
