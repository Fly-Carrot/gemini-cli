/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ShellExecutionService } from '@google/gemini-cli-core';
import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import {
  MessageType,
  type HistoryItemInfo,
  type HistoryItemWarning,
} from '../types.js';
import {
  AutomationStrategyService,
  describeShellReplyMode,
  type ShellReplyMode,
} from '../../services/automationStrategyService.js';
import {
  analyzeActiveShellPrompt,
  getShellPromptSummary,
} from '../../services/shellReplyService.js';

function getAutomationStrategyService(
  context: CommandContext,
): AutomationStrategyService | null {
  const config = context.services.agentContext?.config;
  return config ? new AutomationStrategyService(config) : null;
}

function isShellReplyMode(value: string): value is ShellReplyMode {
  return value === 'manual' || value === 'suggest' || value === 'auto';
}

function getActiveShellPtyId(context: CommandContext): number | null {
  const pending = context.ui.pendingItem;
  if (!pending || pending.type !== 'tool_group') {
    return null;
  }

  for (const tool of pending.tools) {
    if (typeof tool.ptyId === 'number') {
      return tool.ptyId;
    }
  }

  return null;
}

async function modeAction(
  context: CommandContext,
  mode: ShellReplyMode,
): Promise<void | SlashCommandActionReturn> {
  const strategyService = getAutomationStrategyService(context);
  if (!strategyService) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    };
  }

  await strategyService.setShellReplyMode(mode);
  context.ui.addItem({
    type: MessageType.INFO,
    text: `Shell-reply automation set to ${mode}.`,
    secondaryText: describeShellReplyMode(mode),
  } as HistoryItemInfo);
}

async function statusAction(
  context: CommandContext,
): Promise<void | SlashCommandActionReturn> {
  const strategyService = getAutomationStrategyService(context);
  if (!strategyService) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    };
  }

  const strategy = await strategyService.getState();
  const activePtyId = getActiveShellPtyId(context) ?? undefined;
  const analysis = analyzeActiveShellPrompt(
    context.ui.pendingItem,
    activePtyId,
  );

  context.ui.addItem({
    type: MessageType.INFO,
    text: `Shell-reply mode: ${strategy.shellReplyMode}.`,
    secondaryText: describeShellReplyMode(strategy.shellReplyMode),
  });

  context.ui.addItem({
    type: analysis ? MessageType.WARNING : MessageType.INFO,
    text: analysis
      ? `Interactive shell prompt detected on PTY ${activePtyId}.`
      : 'No interactive shell prompt detected right now.',
    secondaryText: analysis
      ? getShellPromptSummary(analysis)
      : 'If a shell command stalls waiting for input, use /shell-reply status to inspect it.',
  });

  if (analysis && analysis.suggestedReply !== undefined) {
    context.ui.addItem({
      type: MessageType.INFO,
      text: `Suggested shell reply: ${
        analysis.suggestionLabel ?? JSON.stringify(analysis.suggestedReply)
      }.`,
      secondaryText:
        'Use /shell-reply reply to send it. Omit the argument to send Enter.',
    } as HistoryItemInfo);
  } else if (analysis) {
    context.ui.addItem({
      type: MessageType.INFO,
      text: 'No safe automatic reply was inferred.',
      secondaryText:
        'Tab into the shell to answer manually, or use /agents task shell_reply <prompt> for deeper analysis.',
    } as HistoryItemInfo);
  }
}

async function replyAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const activePtyId = getActiveShellPtyId(context);
  if (!activePtyId) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'No active interactive shell is awaiting input.',
    };
  }

  const replyText = args;
  const payload = replyText.length > 0 ? `${replyText}\n` : '\n';
  ShellExecutionService.writeToPty(activePtyId, payload);

  context.ui.addItem({
    type: MessageType.INFO,
    text:
      replyText.length > 0
        ? `Sent shell reply to PTY ${activePtyId}.`
        : `Sent Enter to shell PTY ${activePtyId}.`,
    secondaryText:
      replyText.length > 0
        ? `Reply: ${replyText}`
        : 'The shell asked for a plain Enter confirmation.',
  } as HistoryItemInfo);
}

export const shellReplyCommand: SlashCommand = {
  name: 'shell-reply',
  altNames: ['shellreply'],
  description:
    'Inspect or automate replies to interactive shell prompts. Usage: /shell-reply [manual | suggest | auto | status | reply]',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  subCommands: [
    {
      name: 'manual',
      description:
        'Detect shell prompts but leave all replies to you. Usage: /shell-reply manual',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: (context) => modeAction(context, 'manual'),
    },
    {
      name: 'suggest',
      description:
        'Suggest replies for shell prompts without auto-sending them. Usage: /shell-reply suggest',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: (context) => modeAction(context, 'suggest'),
    },
    {
      name: 'auto',
      description:
        'Auto-reply only to clearly low-risk shell prompts. Usage: /shell-reply auto',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: (context) => modeAction(context, 'auto'),
    },
    {
      name: 'status',
      description:
        'Show shell-reply mode and any detected interactive prompt. Usage: /shell-reply status',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: statusAction,
    },
    {
      name: 'reply',
      description:
        'Send a reply to the active shell prompt. Usage: /shell-reply reply <text> (or omit text to send Enter)',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: (context, args) => replyAction(context, args),
    },
  ],
  action: async (context, args) => {
    const trimmed = args.trim();
    if (!trimmed) {
      return statusAction(context);
    }

    const [primary, ...rest] = trimmed.split(/\s+/);
    const normalizedPrimary = primary.toLowerCase();

    if (isShellReplyMode(normalizedPrimary)) {
      return modeAction(context, normalizedPrimary);
    }

    if (normalizedPrimary === 'reply') {
      return replyAction(context, rest.join(' '));
    }

    if (normalizedPrimary === 'status') {
      return statusAction(context);
    }

    context.ui.addItem({
      type: MessageType.WARNING,
      text: `Unknown shell-reply subcommand "${normalizedPrimary}".`,
    } as HistoryItemWarning);
  },
};
