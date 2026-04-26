/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  addMemory,
  listMemoryFiles,
  refreshMemory,
  showMemory,
} from '@google/gemini-cli-core';
import { type HistoryItemInfo, MessageType } from '../types.js';
import {
  CommandKind,
  type OpenCustomDialogActionReturn,
  type SlashCommand,
  type SlashCommandActionReturn,
} from './types.js';
import { SkillInboxDialog } from '../components/SkillInboxDialog.js';
import { SharedFabricRegistry } from '../../services/sharedFabricRegistry.js';

function getSharedFabricRegistry(context: {
  services: { settings: { workspace?: { path?: string } } };
}): SharedFabricRegistry {
  return new SharedFabricRegistry({
    workspaceRoot:
      context.services.settings.workspace?.path ||
      process.env['GEMINI2_SHARED_FABRIC_WORKSPACE'] ||
      process.cwd(),
  });
}

export const memoryCommand: SlashCommand = {
  name: 'memory',
  description: 'Commands for interacting with memory',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  subCommands: [
    {
      name: 'show',
      description: 'Show the current memory contents',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: async (context) => {
        const config = context.services.agentContext?.config;
        if (!config) return;
        const result = showMemory(config);

        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: result.content,
          },
          Date.now(),
        );
      },
    },
    {
      name: 'add',
      description: 'Add content to the memory',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: (context, args): SlashCommandActionReturn | void => {
        const result = addMemory(args);

        if (result.type === 'message') {
          return result;
        }

        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: `Attempting to save to memory: "${args.trim()}"`,
          },
          Date.now(),
        );

        return result;
      },
    },
    {
      name: 'reload',
      altNames: ['refresh'],
      description: 'Reload the memory from the source',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: async (context) => {
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: 'Reloading memory from source files...',
          },
          Date.now(),
        );

        try {
          const config = context.services.agentContext?.config;
          if (config) {
            const result = await refreshMemory(config);

            context.ui.addItem(
              {
                type: MessageType.INFO,
                text: result.content,
              },
              Date.now(),
            );
          }
        } catch (error) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
              text: `Error reloading memory: ${(error as Error).message}`,
            },
            Date.now(),
          );
        }
      },
    },
    {
      name: 'list',
      description: 'Lists the paths of the GEMINI.md files in use',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: async (context) => {
        const config = context.services.agentContext?.config;
        if (!config) return;
        const result = listMemoryFiles(config);

        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: result.content,
          },
          Date.now(),
        );
      },
    },
    {
      name: 'team',
      description: 'Show layered team memory lanes and shared-fabric overlay',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: async (context): Promise<void | SlashCommandActionReturn> => {
        const config = context.services.agentContext?.config;
        if (!config) {
          return {
            type: 'message',
            messageType: 'error',
            content: 'Config not loaded.',
          };
        }

        const memoryManager = config.getMemoryContextManager();
        const loadedPaths = memoryManager
          ? Array.from(memoryManager.getLoadedPaths())
          : config.getGeminiMdFilePaths();
        const extensionMemory = memoryManager?.getExtensionMemory() ?? '';
        const userProjectMemory = memoryManager?.getUserProjectMemory() ?? '';
        const sharedFabricStatus =
          await getSharedFabricRegistry(context).getStatus();
        const memoryInfo: HistoryItemInfo = {
          type: MessageType.INFO,
          text: `Team memory lanes loaded from ${loadedPaths.length} file(s).`,
          secondaryText: [
            `global ${config.getGlobalMemory().length}c`,
            `extension ${extensionMemory.length}c`,
            `project ${config.getEnvironmentMemory().length}c`,
            `user-project ${userProjectMemory.length}c`,
          ].join(' · '),
        };

        context.ui.addItem(memoryInfo);
        context.ui.addItem({
          type: sharedFabricStatus.workspaceOverlayExists
            ? MessageType.INFO
            : MessageType.WARNING,
          text: sharedFabricStatus.workspaceOverlayExists
            ? 'Shared-fabric question-profile overlay is available to team memory.'
            : 'Shared-fabric question-profile overlay is missing from team memory.',
        });
        context.ui.addItem({
          type: MessageType.INFO,
          text: sharedFabricStatus.workspaceOverlayPath,
        } as HistoryItemInfo);
        if (loadedPaths.length > 0) {
          context.ui.addItem({
            type: MessageType.INFO,
            text: `Loaded memory paths: ${loadedPaths.slice(0, 5).join(', ')}`,
            secondaryText:
              loadedPaths.length > 5
                ? `${loadedPaths.length - 5} additional paths are currently loaded.`
                : undefined,
          } as HistoryItemInfo);
        }

        return undefined;
      },
    },
    {
      name: 'inbox',
      description:
        'Review skills extracted from past sessions and move them to global or project skills',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: (
        context,
      ): OpenCustomDialogActionReturn | SlashCommandActionReturn | void => {
        const config = context.services.agentContext?.config;
        if (!config) {
          return {
            type: 'message',
            messageType: 'error',
            content: 'Config not loaded.',
          };
        }

        if (!config.isAutoMemoryEnabled()) {
          return {
            type: 'message',
            messageType: 'info',
            content:
              'The memory inbox requires Auto Memory. Enable it with: experimental.autoMemory = true in settings.',
          };
        }

        return {
          type: 'custom_dialog',
          component: React.createElement(SkillInboxDialog, {
            config,
            onClose: () => context.ui.removeComponent(),
            onReloadSkills: async () => {
              await config.reloadSkills();
              context.ui.reloadCommands();
            },
          }),
        };
      },
    },
  ],
};
