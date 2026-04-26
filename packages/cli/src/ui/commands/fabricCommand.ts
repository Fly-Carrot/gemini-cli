/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  type CommandContext,
  type SlashCommand,
  type SlashCommandActionReturn,
  CommandKind,
} from './types.js';
import {
  type HistoryItemInfo,
  type HistoryItemSkillsList,
  MessageType,
} from '../types.js';
import { parseSlashCommand } from '../../utils/commands.js';
import { SharedFabricRegistry } from '../../services/sharedFabricRegistry.js';

const execFileAsync = promisify(execFile);
const PROFILE_SECTION_KEY_MAP: Record<string, string> = {
  'Core Focus Points': 'focus_points',
  'Question Patterns': 'question_patterns',
  'Response Preferences': 'response_preferences',
  'Reasoning Preferences': 'reasoning_preferences',
  'Recurring Themes': 'recurring_themes',
  'Frictions or Anxieties': 'frictions_or_anxieties',
};

function getSharedFabricRegistry(
  context: CommandContext,
): SharedFabricRegistry {
  const settingsWithWorkspace = context.services.settings as {
    workspace?: { path?: string };
  };
  return new SharedFabricRegistry({
    workspaceRoot:
      settingsWithWorkspace.workspace?.path ||
      process.env['GEMINI2_SHARED_FABRIC_WORKSPACE'] ||
      process.cwd(),
  });
}

function buildFallbackProfilePayload(
  summary: string,
): Record<string, string[]> {
  return {
    focus_points: [summary],
    question_patterns: [
      'Triggered shared-fabric postflight from Gemini-2 runtime.',
    ],
    response_preferences: [
      'Maintain current session language and concise engineering framing.',
    ],
    reasoning_preferences: [
      'Prefer explicit tradeoffs and low-risk reversible rollout.',
    ],
    recurring_themes: ['shared-fabric lifecycle', 'Gemini-2 runtime'],
    frictions_or_anxieties: [
      'Avoid unsynchronized runtime state and hidden integration gaps.',
    ],
  };
}

function parseUserQuestionProfileMarkdown(
  markdown: string,
  summary: string,
): Record<string, string[]> {
  const payload = buildFallbackProfilePayload(summary);
  const lines = markdown.split(/\r?\n/);
  let currentKey: string | undefined;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      currentKey = PROFILE_SECTION_KEY_MAP[headingMatch[1].trim()];
      continue;
    }

    if (!currentKey) {
      continue;
    }

    const bulletMatch = line.match(/^\s*-\s+(.+?)\s*$/);
    if (!bulletMatch) {
      continue;
    }

    const value = bulletMatch[1].trim();
    if (!value) {
      continue;
    }

    payload[currentKey] = [...(payload[currentKey] || []), value];
  }

  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function statusAction(
  context: CommandContext,
): Promise<void | SlashCommandActionReturn> {
  const registry = getSharedFabricRegistry(context);
  const status = await registry.getStatus();
  context.ui.addItem({
    type: status.available ? MessageType.INFO : MessageType.WARNING,
    text: status.available
      ? 'Shared fabric detected and ready for Gemini-2.'
      : 'Shared fabric is only partially available to Gemini-2.',
  });
  context.ui.addItem({
    type: MessageType.INFO,
    text: [
      `${status.sources.length} skill source${status.sources.length === 1 ? '' : 's'}`,
      `${status.indexedSkillCount} indexed skills`,
      `${status.routedDomainCount} routed domains`,
      status.workspaceOverlayExists
        ? 'workspace overlay detected'
        : 'workspace overlay missing',
    ].join(' · '),
  } as HistoryItemInfo);

  context.ui.addItem({
    type: MessageType.INFO,
    text: `Global root: ${status.globalRoot}`,
    secondaryText: `Runtime map: ${status.runtimeMapPath}`,
  } as HistoryItemInfo);
  context.ui.addItem({
    type: MessageType.INFO,
    text: `Workspace root: ${status.workspaceRoot}`,
    secondaryText: `Question profile overlay: ${status.workspaceOverlayPath}`,
  } as HistoryItemInfo);
}

async function routeAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const query = args.trim();
  if (!query) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Usage: /fabric route <query>',
    });
    return;
  }

  const registry = getSharedFabricRegistry(context);
  const result = await registry.recommendSkills(query, 8);

  if (result.skills.length === 0) {
    context.ui.addItem({
      type: MessageType.INFO,
      text: `No shared-fabric route results were found for "${query}".`,
      secondaryText:
        'Try /skills search <query> or inspect /fabric status for path readiness.',
    } as HistoryItemInfo);
    return;
  }

  context.ui.addItem({
    type: MessageType.INFO,
    text: result.domain
      ? `Routed "${query}" to ${result.domain.label}.`
      : `Prepared shared-fabric suggestions for "${query}".`,
    secondaryText:
      result.domain?.summary ||
      'Use /skills use <name> to pull one of these skills into this session.',
  } as HistoryItemInfo);
  context.ui.addItem({
    type: MessageType.SKILLS_LIST,
    skills: result.skills,
    showDescriptions: true,
  } as HistoryItemSkillsList);
}

async function syncAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const summary = args.trim();
  if (!summary) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Usage: /fabric sync <summary>',
    });
    context.ui.addItem({
      type: MessageType.INFO,
      text: 'Provide a short task summary so Gemini-2 can write a canonical postflight bundle.',
    } as HistoryItemInfo);
    return;
  }

  const registry = getSharedFabricRegistry(context);
  const overlayMarkdown = await fs
    .readFile(registry.workspaceOverlayPath, 'utf-8')
    .catch(() => '');
  const profilePayload = parseUserQuestionProfileMarkdown(
    overlayMarkdown,
    summary,
  );
  const taskId =
    process.env['GEMINI2_BOOT_TASK_ID'] ||
    context.session.stats.sessionId ||
    `gemini2-${Date.now()}`;
  const scriptPath = path.join(
    registry.globalRoot,
    'scripts',
    'sync',
    'postflight_sync.py',
  );

  try {
    const { stdout } = await execFileAsync(
      'python3',
      [
        scriptPath,
        '--global-root',
        registry.globalRoot,
        '--workspace',
        registry.workspaceRoot,
        '--agent',
        'gemini-2',
        '--task-id',
        taskId,
        '--summary',
        summary,
        '--details',
        'Triggered from gemini-2 /fabric sync.',
        '--user-question-profile-json',
        JSON.stringify(profilePayload),
      ],
      { env: process.env },
    );

    let syncResult: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(stdout);
      syncResult = isRecord(parsed) ? parsed : null;
    } catch {
      syncResult = null;
    }

    context.ui.addItem({
      type: MessageType.INFO,
      text: '[SYNC_OK] Shared-fabric postflight written.',
      secondaryText: [
        `task-id=${taskId}`,
        registry.workspaceOverlayPath,
        syncResult?.['user_question_profile_target']
          ? String(syncResult['user_question_profile_target'])
          : 'user-question-profile included',
      ].join(' · '),
    } as HistoryItemInfo);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown postflight error.';
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Shared-fabric postflight failed.',
    });
    context.ui.addItem({
      type: MessageType.INFO,
      text: message,
    } as HistoryItemInfo);
  }
}

export const fabricCommand: SlashCommand = {
  name: 'fabric',
  description:
    'Inspect Gemini-2 shared-fabric integration. Usage: /fabric [status | route <query> | sync <summary>]',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  subCommands: [
    {
      name: 'status',
      description: 'Show shared-fabric status. Usage: /fabric status',
      kind: CommandKind.BUILT_IN,
      action: statusAction,
    },
    {
      name: 'route',
      description:
        'Route a task to shared-fabric skills. Usage: /fabric route <query>',
      kind: CommandKind.BUILT_IN,
      action: routeAction,
    },
    {
      name: 'sync',
      description:
        'Write a canonical shared-fabric postflight bundle. Usage: /fabric sync <summary>',
      kind: CommandKind.BUILT_IN,
      action: syncAction,
    },
  ],
  action: async (context, args) => {
    if (args) {
      const parsed = parseSlashCommand(`/${args}`, fabricCommand.subCommands!);
      if (parsed.commandToExecute?.action) {
        return parsed.commandToExecute.action(context, parsed.args);
      }
    }
    return statusAction(context);
  },
};
