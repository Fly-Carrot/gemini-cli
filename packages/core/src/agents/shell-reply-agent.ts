/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import type { AgentDefinition } from './types.js';
import { GEMINI_MODEL_ALIAS_FLASH } from '../config/models.js';
import { ThinkingLevel } from '@google/genai';
import type { AgentLoopContext } from '../config/agent-loop-context.js';

const ShellReplyReportSchema = z.object({
  classification: z
    .enum([
      'confirmation',
      'press_enter',
      'path_input',
      'choice_input',
      'freeform_input',
      'unknown',
    ])
    .describe('The prompt category inferred from the shell output.'),
  risk: z
    .enum(['low', 'medium', 'high'])
    .describe('How risky it would be to answer automatically.'),
  recommended_reply: z
    .string()
    .describe(
      'The suggested reply text without any trailing newline. Empty string means press Enter.',
    ),
  rationale: z
    .string()
    .describe('A concise explanation of why this reply is or is not safe.'),
});

/**
 * A focused helper agent for stalled interactive shell prompts.
 */
export const ShellReplyAgent = (
  _context: AgentLoopContext,
): AgentDefinition<typeof ShellReplyReportSchema> => ({
  name: 'shell_reply',
  kind: 'local',
  displayName: 'Shell Reply Agent',
  description:
    'Analyzes an interactive shell prompt and recommends a safe reply. Use this when a shell command is waiting for input and the answer is ambiguous enough that Gemini-2 should not guess blindly.',
  inputConfig: {
    inputSchema: {
      type: 'object',
      properties: {
        shell_output: {
          type: 'string',
          description:
            'Recent shell output, including the exact prompt that is waiting for input.',
        },
        current_command: {
          type: 'string',
          description:
            'The shell command currently running, if known. This helps estimate risk.',
        },
        task_goal: {
          type: 'string',
          description:
            'The broader user task or loop goal, if known. Use it only as context for safer recommendations.',
        },
      },
      required: ['shell_output'],
    },
  },
  outputConfig: {
    outputName: 'report',
    description: 'A structured shell-reply recommendation as a JSON object.',
    schema: ShellReplyReportSchema,
  },
  processOutput: (output) => JSON.stringify(output, null, 2),
  modelConfig: {
    model: GEMINI_MODEL_ALIAS_FLASH,
    generateContentConfig: {
      temperature: 0.1,
      topP: 0.95,
      thinkingConfig: {
        includeThoughts: true,
        thinkingLevel: ThinkingLevel.HIGH,
      },
    },
  },
  runConfig: {
    maxTimeMinutes: 2,
    maxTurns: 8,
  },
  promptConfig: {
    query:
      'You are analyzing a shell prompt that is waiting for input.\n' +
      '<shell_output>\n${shell_output}\n</shell_output>\n' +
      '<current_command>\n${current_command}\n</current_command>\n' +
      '<task_goal>\n${task_goal}\n</task_goal>',
    systemPrompt:
      'You are Shell Reply Agent, a focused safety helper for interactive shell prompts.\n\n' +
      'Your job is to decide whether a shell prompt can be answered safely, and if so, what the best reply is.\n\n' +
      'Rules:\n' +
      '1. Be conservative. If you are not confident, set risk to medium or high and keep recommended_reply empty.\n' +
      '2. Never invent secrets, credentials, destructive confirmations, or destination paths that were not explicitly provided.\n' +
      '3. Empty recommended_reply means “do not auto-answer”.\n' +
      '4. If the prompt is just “Press Enter to continue”, use an empty string as recommended_reply and classify it as press_enter.\n' +
      '5. If the prompt is a simple safe confirmation such as [Y/n], recommend "y" only when the action appears routine and non-destructive.\n' +
      '6. Return JSON only by calling complete_task with the structured report.',
  },
});
