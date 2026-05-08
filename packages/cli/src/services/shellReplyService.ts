/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AnsiOutput } from '@google/gemini-cli-core';
import { type HistoryItemWithoutId, isAnsiOutput } from '../ui/types.js';

export type ShellPromptKind =
  | 'confirmation'
  | 'press_enter'
  | 'path_input'
  | 'choice_input'
  | 'freeform_input';

export interface ShellPromptAnalysis {
  kind: ShellPromptKind;
  promptText: string;
  suggestedReply?: string;
  suggestionLabel?: string;
  autoSafe: boolean;
  reason: string;
}

function ansiOutputToText(output: AnsiOutput): string {
  return output
    .map((line) => line.map((token) => token.text).join(''))
    .join('\n');
}

function getToolOutputText(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  if (isAnsiOutput(output)) {
    return ansiOutputToText(output);
  }
  return '';
}

function findPromptCandidate(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (
      /\[[Yy]\/[Nn]\]|\[[Nn]\/[Yy]\]|\([Yy]\/[Nn]\)|\([Nn]\/[Yy]\)/.test(
        line,
      ) ||
      /\b(press enter|hit enter|continue\??|proceed\??|confirm)\b/i.test(
        line,
      ) ||
      /(请输入|输入|路径|absolute\/relative path|file path|select|choose|pick)\b/i.test(
        line,
      ) ||
      /[:?：？]$/.test(line)
    ) {
      return line;
    }
  }

  return null;
}

function classifyPrompt(promptText: string): ShellPromptAnalysis {
  if (/\b(press enter|hit enter)\b/i.test(promptText)) {
    return {
      kind: 'press_enter',
      promptText,
      suggestedReply: '',
      suggestionLabel: '<Enter>',
      autoSafe: true,
      reason: 'The shell is explicitly asking for Enter to continue.',
    };
  }

  const isYesNo =
    /\[[Yy]\/[Nn]\]|\[[Nn]\/[Yy]\]|\([Yy]\/[Nn]\)|\([Nn]\/[Yy]\)/.test(
      promptText,
    ) || /\b(continue|proceed|confirm)\b/i.test(promptText);

  if (isYesNo) {
    const destructive =
      /\b(delete|remove|overwrite|destroy|drop|erase|uninstall)\b/i.test(
        promptText,
      );
    return {
      kind: 'confirmation',
      promptText,
      suggestedReply: 'y',
      suggestionLabel: 'y',
      autoSafe: !destructive,
      reason: destructive
        ? 'The prompt looks like a destructive confirmation, so Gemini-2 should not auto-answer it.'
        : 'The prompt looks like a routine confirmation and can usually be answered with yes.',
    };
  }

  if (
    /(请输入|路径|absolute\/relative path|file path|markdown 文件|markdown file)/i.test(
      promptText,
    )
  ) {
    return {
      kind: 'path_input',
      promptText,
      autoSafe: false,
      reason:
        'The shell is asking for a path. Gemini-2 can explain the prompt, but it should not invent a destination path automatically.',
    };
  }

  if (/\b(select|choose|pick)\b/i.test(promptText)) {
    return {
      kind: 'choice_input',
      promptText,
      autoSafe: false,
      reason:
        'The shell is asking you to choose an option. This usually needs human confirmation or a dedicated subagent analysis.',
    };
  }

  return {
    kind: 'freeform_input',
    promptText,
    autoSafe: false,
    reason:
      'The shell appears to be waiting for freeform input, so Gemini-2 should pause and ask for review instead of guessing.',
  };
}

function getActiveShellTool(
  pendingItem: HistoryItemWithoutId | null | undefined,
  activePtyId: number | undefined,
) {
  if (!pendingItem || pendingItem.type !== 'tool_group' || !activePtyId) {
    return null;
  }

  return pendingItem.tools.find((tool) => tool.ptyId === activePtyId) ?? null;
}

export function analyzeActiveShellPrompt(
  pendingItem: HistoryItemWithoutId | null | undefined,
  activePtyId: number | undefined,
): ShellPromptAnalysis | null {
  const activeTool = getActiveShellTool(pendingItem, activePtyId);
  if (!activeTool) {
    return null;
  }

  const outputText = getToolOutputText(activeTool.resultDisplay);
  if (!outputText) {
    return null;
  }

  const promptText = findPromptCandidate(outputText);
  if (!promptText) {
    return null;
  }

  return classifyPrompt(promptText);
}

export function getShellPromptSummary(
  analysis: ShellPromptAnalysis | null,
): string {
  if (!analysis) {
    return 'No interactive shell prompt detected right now.';
  }

  const suggestion = analysis.suggestionLabel
    ? ` Suggested reply: ${analysis.suggestionLabel}.`
    : '';
  return `${analysis.promptText}${suggestion}`;
}
