/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@google/gemini-cli-core';
import {
  type CommandContext,
  type SlashCommand,
  type SlashCommandActionReturn,
  CommandKind,
} from './types.js';
import {
  type HistoryItemCompression,
  type HistoryItemInfo,
  MessageType,
} from '../types.js';
import { parseSlashCommand } from '../../utils/commands.js';
import {
  QueryRuntimeService,
  type QueryRuntimeSnapshot,
} from '../../services/queryRuntimeService.js';

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

function getRuntimeService(
  context: CommandContext,
): QueryRuntimeService | null {
  const config = getConfig(context);
  if (!config) {
    return null;
  }

  return new QueryRuntimeService(config, context.session.stats, {
    workspaceRoot: getWorkspaceRoot(context),
  });
}

function formatThreshold(snapshot: QueryRuntimeSnapshot): string {
  if (
    snapshot.compressionThreshold === undefined ||
    snapshot.compressionThresholdTokenCount === undefined ||
    snapshot.compressionThresholdUsagePercent === undefined
  ) {
    return 'compression threshold: manual only';
  }

  return `compression threshold: ${Math.round(snapshot.compressionThreshold * 100)}% (${snapshot.compressionThresholdTokenCount.toLocaleString()} tokens, ${snapshot.compressionThresholdUsagePercent}% used)`;
}

async function statusAction(
  context: CommandContext,
): Promise<void | SlashCommandActionReturn> {
  const runtimeService = getRuntimeService(context);
  if (!runtimeService) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    };
  }

  const snapshot = await runtimeService.captureSnapshot();

  context.ui.addItem({
    type: MessageType.INFO,
    text: `Gemini-2 QueryRuntime captured for session ${snapshot.sessionId}.`,
    secondaryText: `model ${snapshot.model} · ${snapshot.promptCount} prompts · bridge ${snapshot.bridge.snapshotPath}`,
  } as HistoryItemInfo);
  context.ui.addItem({
    type: MessageType.INFO,
    text: `Context usage: ${snapshot.lastPromptTokenCount.toLocaleString()} / ${snapshot.tokenLimit.toLocaleString()} tokens (${snapshot.contextUsagePercent}%).`,
    secondaryText: formatThreshold(snapshot),
  } as HistoryItemInfo);
  context.ui.addItem({
    type: MessageType.INFO,
    text: `Memory lanes: ${snapshot.memory.loadedPathCount} loaded files · global ${snapshot.memory.globalChars}c · extension ${snapshot.memory.extensionChars}c · project ${snapshot.memory.projectChars}c · user-project ${snapshot.memory.userProjectChars}c`,
    secondaryText: snapshot.sharedFabric.workspaceOverlayExists
      ? `Shared-fabric overlay detected at ${snapshot.sharedFabric.workspaceOverlayPath}`
      : `Shared-fabric overlay missing at ${snapshot.sharedFabric.workspaceOverlayPath}`,
  } as HistoryItemInfo);
  context.ui.addItem({
    type: MessageType.INFO,
    text: `Automation: loop ${snapshot.automation.loopMode} · skills ${snapshot.automation.skillsMode} · agents ${snapshot.automation.agentsMode}.`,
    secondaryText: `Runtime has ${snapshot.activeSkillNames.length} active skills loaded · ${snapshot.discoveredAgentNames.length} agents registered · ${snapshot.checkpoints.count} checkpoints.`,
  } as HistoryItemInfo);
  context.ui.addItem({
    type: MessageType.INFO,
    text: `Skills and agents: ${snapshot.activeSkillNames.length} active skills loaded · ${snapshot.discoveredAgentNames.length} agents registered · ${snapshot.checkpoints.count} checkpoints`,
    secondaryText: snapshot.activeSkillNames.length
      ? `Active skills: ${snapshot.activeSkillNames.join(', ')}. Registered agents are available definitions, not proof that a subagent is currently running.`
      : 'Run /skills use <name> to load guidance, or /agents task <agent> <prompt> to explicitly fork a subagent task.',
  } as HistoryItemInfo);
  context.ui.addItem({
    type: MessageType.INFO,
    text:
      snapshot.loop.status === 'idle'
        ? 'Loop runtime: idle.'
        : `Loop runtime: ${snapshot.loop.status} · iteration ${snapshot.loop.iteration}/${snapshot.loop.maxIterations ?? '?'}${snapshot.loop.autoRunEnabled ? ' · autorun on' : ''}.`,
    secondaryText: snapshot.loop.goal
      ? snapshot.loop.stopCategory
        ? `${snapshot.loop.goal} · stop category: ${snapshot.loop.stopCategory}`
        : snapshot.loop.goal
      : 'Run /loop start <goal> to begin a long-horizon execution loop.',
  } as HistoryItemInfo);
}

async function bridgeAction(
  context: CommandContext,
): Promise<void | SlashCommandActionReturn> {
  const runtimeService = getRuntimeService(context);
  if (!runtimeService) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    };
  }

  const snapshot = await runtimeService.captureSnapshot();
  context.ui.addItem({
    type: MessageType.INFO,
    text: 'Wrote Gemini-2 runtime bridge snapshot.',
    secondaryText: `${snapshot.bridge.snapshotPath} · updated ${snapshot.bridge.updatedAt}`,
  } as HistoryItemInfo);
}

async function compactAction(
  context: CommandContext,
): Promise<void | SlashCommandActionReturn> {
  const runtimeService = getRuntimeService(context);
  if (!runtimeService) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    };
  }

  const geminiClient = context.services.agentContext?.geminiClient;
  if (!geminiClient) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Gemini client not loaded.',
    };
  }

  const { ui } = context;
  if (ui.pendingItem) {
    ui.addItem(
      {
        type: MessageType.ERROR,
        text: 'Already compressing, wait for previous request to complete',
      },
      Date.now(),
    );
    return;
  }

  const pendingMessage: HistoryItemCompression = {
    type: MessageType.COMPRESSION,
    compression: {
      isPending: true,
      originalTokenCount: null,
      newTokenCount: null,
      compressionStatus: null,
    },
  };

  try {
    ui.setPendingItem(pendingMessage);
    const promptId = `runtime-compact-${Date.now()}`;
    const compressed = await geminiClient.tryCompressChat(promptId, true);
    if (!compressed) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Failed to compress chat history.',
        },
        Date.now(),
      );
      return;
    }

    ui.addItem(
      {
        type: MessageType.COMPRESSION,
        compression: {
          isPending: false,
          originalTokenCount: compressed.originalTokenCount,
          newTokenCount: compressed.newTokenCount,
          compressionStatus: compressed.compressionStatus,
        },
      } as HistoryItemCompression,
      Date.now(),
    );

    const snapshot = await runtimeService.captureSnapshot();
    ui.addItem(
      {
        type: MessageType.INFO,
        text: 'QueryRuntime bridge refreshed after compaction.',
        secondaryText: `${snapshot.lastPromptTokenCount.toLocaleString()} prompt tokens remain in active context · bridge ${snapshot.bridge.snapshotPath}`,
      } as HistoryItemInfo,
      Date.now(),
    );
  } catch (error) {
    ui.addItem(
      {
        type: MessageType.ERROR,
        text: `Failed to compress chat history: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      Date.now(),
    );
  } finally {
    ui.setPendingItem(null);
  }
}

export const runtimeCommand: SlashCommand = {
  name: 'runtime',
  description:
    'Inspect the Gemini-2 query runtime. Usage: /runtime [status | compact | bridge]',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  subCommands: [
    {
      name: 'status',
      description: 'Show query runtime status. Usage: /runtime status',
      kind: CommandKind.BUILT_IN,
      action: statusAction,
    },
    {
      name: 'compact',
      altNames: ['compress'],
      description:
        'Compress context and refresh the runtime bridge. Usage: /runtime compact',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: compactAction,
    },
    {
      name: 'bridge',
      description:
        'Write a runtime bridge snapshot for external tooling. Usage: /runtime bridge',
      kind: CommandKind.BUILT_IN,
      action: bridgeAction,
    },
  ],
  action: async (context, args) => {
    if (args) {
      const parsed = parseSlashCommand(`/${args}`, runtimeCommand.subCommands!);
      if (parsed.commandToExecute?.action) {
        return parsed.commandToExecute.action(context, parsed.args);
      }
    }
    return statusAction(context);
  },
};
