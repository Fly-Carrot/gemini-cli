/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ShellExecutionService } from '@google/gemini-cli-core';
import { shellReplyCommand } from './shellReplyCommand.js';
import {
  CoreToolCallStatus,
  MessageType,
  type HistoryItemToolGroup,
  type ToolResultDisplay,
} from '../types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import {
  createMockConfig,
  createMockSettings,
} from '../../test-utils/mockConfig.js';
import type { CommandContext } from './types.js';

vi.mock('@google/gemini-cli-core', async () => {
  const actual = await vi.importActual<
    typeof import('@google/gemini-cli-core')
  >('@google/gemini-cli-core');
  return {
    ...actual,
    ShellExecutionService: {
      writeToPty: vi.fn(),
    },
  };
});

function makePendingShell(
  resultDisplay: ToolResultDisplay,
): HistoryItemToolGroup {
  return {
    type: 'tool_group',
    tools: [
      {
        callId: 'call-shell',
        name: 'Shell',
        description: 'Shell command',
        resultDisplay,
        status: CoreToolCallStatus.Executing,
        confirmationDetails: undefined,
        ptyId: 42,
      },
    ],
  };
}

describe('shellReplyCommand', () => {
  let tempDir: string;
  let context: CommandContext;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-shell-reply-'));
    const config = createMockConfig({
      getWorkingDir: () => '/workspace',
      getSessionId: () => 'shell-reply-session',
    });
    config.storage.getProjectTempDir = () => tempDir;

    context = createMockCommandContext({
      services: {
        agentContext: {
          config,
        },
        settings: createMockSettings({
          workspace: { settings: {}, path: '/workspace' },
        }),
      },
      ui: {
        pendingItem: makePendingShell('Continue? [Y/n]'),
      },
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('switches shell-reply mode directly', async () => {
    await shellReplyCommand.action!(context, 'auto');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: 'Shell-reply automation set to auto.',
      }),
    );
  });

  it('shows detected prompt status and suggested reply', async () => {
    const status = shellReplyCommand.subCommands!.find(
      (cmd) => cmd.name === 'status',
    )!;

    await status.action!(context, '');

    expect(context.ui.addItem).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: MessageType.INFO,
        text: 'Shell-reply mode: suggest.',
      }),
    );
    expect(context.ui.addItem).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: MessageType.WARNING,
        text: 'Interactive shell prompt detected on PTY 42.',
      }),
    );
    expect(context.ui.addItem).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        type: MessageType.INFO,
        text: 'Suggested shell reply: y.',
      }),
    );
  });

  it('writes a reply into the active shell PTY', async () => {
    const reply = shellReplyCommand.subCommands!.find(
      (cmd) => cmd.name === 'reply',
    )!;

    await reply.action!(context, 'custom/path.md');

    expect(ShellExecutionService.writeToPty).toHaveBeenCalledWith(
      42,
      'custom/path.md\n',
    );
    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: 'Sent shell reply to PTY 42.',
      }),
    );
  });
});
