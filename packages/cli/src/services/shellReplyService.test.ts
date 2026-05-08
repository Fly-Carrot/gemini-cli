/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { analyzeActiveShellPrompt } from './shellReplyService.js';
import type { HistoryItemToolGroup, ToolResultDisplay } from '../ui/types.js';
import { CoreToolCallStatus } from '../ui/types.js';

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

describe('shellReplyService', () => {
  it('detects yes/no confirmations and recommends yes', () => {
    const analysis = analyzeActiveShellPrompt(
      makePendingShell('Continue? [Y/n]'),
      42,
    );

    expect(analysis).toMatchObject({
      kind: 'confirmation',
      suggestedReply: 'y',
      autoSafe: true,
    });
  });

  it('detects press-enter prompts as auto-safe', () => {
    const analysis = analyzeActiveShellPrompt(
      makePendingShell('Press Enter to continue'),
      42,
    );

    expect(analysis).toMatchObject({
      kind: 'press_enter',
      suggestedReply: '',
      autoSafe: true,
    });
  });

  it('detects path prompts but refuses to invent a path', () => {
    const analysis = analyzeActiveShellPrompt(
      makePendingShell('? 请输入目标 Markdown 文件的绝对/相对路径:'),
      42,
    );

    expect(analysis).toMatchObject({
      kind: 'path_input',
      autoSafe: false,
    });
    expect(analysis?.suggestedReply).toBeUndefined();
  });

  it('returns null when there is no active matching PTY', () => {
    const analysis = analyzeActiveShellPrompt(
      makePendingShell('Continue? [Y/n]'),
      7,
    );

    expect(analysis).toBeNull();
  });
});
