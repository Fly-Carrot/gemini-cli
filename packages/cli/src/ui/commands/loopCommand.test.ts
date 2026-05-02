/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loopCommand } from './loopCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import {
  createMockConfig,
  createMockSettings,
} from '../../test-utils/mockConfig.js';
import type { CommandContext } from './types.js';
import { MessageType } from '../types.js';

describe('loopCommand', () => {
  let tempDir: string;
  let context: CommandContext;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-loop-'));
    const config = createMockConfig({
      getSessionId: () => 'session-loop',
      getWorkingDir: () => '/workspace',
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
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('starts a loop and returns a submit_prompt payload', async () => {
    const start = loopCommand.subCommands!.find((cmd) => cmd.name === 'start')!;
    const result = await start.action!(
      context,
      'Ship a stable release --max=5',
    );

    expect(result).toEqual(
      expect.objectContaining({
        type: 'submit_prompt',
      }),
    );
    expect((result as { content: string }).content).toContain(
      'Goal: Ship a stable release',
    );
    expect((result as { content: string }).content).toContain(
      'Iteration: 1 of up to 5',
    );
    expect((result as { content: string }).content).toContain(
      'Loop automation strategy: manual/off',
    );
  });

  it('queues another iteration with operator guidance', async () => {
    const start = loopCommand.subCommands!.find((cmd) => cmd.name === 'start')!;
    await start.action!(context, 'Stabilize CI');

    const next = loopCommand.subCommands!.find((cmd) => cmd.name === 'next')!;
    const result = await next.action!(
      context,
      'Prioritize failing tests first',
    );

    expect((result as { content: string }).content).toContain(
      'Iteration: 2 of up to 12',
    );
    expect((result as { content: string }).content).toContain(
      'Operator guidance for this iteration: Prioritize failing tests first',
    );
  });

  it('pauses and resumes a loop', async () => {
    const start = loopCommand.subCommands!.find((cmd) => cmd.name === 'start')!;
    await start.action!(context, 'Refactor the planner');

    const stop = loopCommand.subCommands!.find((cmd) => cmd.name === 'stop')!;
    await stop.action!(context, 'Need a human checkpoint');

    const resume = loopCommand.subCommands!.find(
      (cmd) => cmd.name === 'resume',
    )!;
    const result = await resume.action!(
      context,
      'Continue with smaller batches',
    );

    expect((result as { content: string }).content).toContain(
      'Iteration: 2 of up to 12',
    );
    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: 'Paused Gemini-2 loop at iteration 1/12.',
      }),
    );
  });

  it('shows loop status from persisted state', async () => {
    const start = loopCommand.subCommands!.find((cmd) => cmd.name === 'start')!;
    await start.action!(context, 'Document the release pipeline');

    const status = loopCommand.subCommands!.find(
      (cmd) => cmd.name === 'status',
    )!;
    await status.action!(context, '');

    expect(context.ui.addItem).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: MessageType.INFO,
        text: 'Loop mode off · active: iteration 1/12.',
      }),
    );
  });

  it('starts autorun directly from /loop run', async () => {
    const run = loopCommand.subCommands!.find((cmd) => cmd.name === 'run')!;
    const result = await run.action!(context, 'Land the release train --max=4');

    expect(result).toEqual(
      expect.objectContaining({
        type: 'submit_prompt',
      }),
    );
    expect((result as { content: string }).content).toContain(
      'Iteration: 1 of up to 4',
    );

    const status = loopCommand.subCommands!.find(
      (cmd) => cmd.name === 'status',
    )!;
    await status.action!(context, '');
    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Loop mode off · active: iteration 1/4 · autorun on.',
      }),
    );
  });

  it('sets loop automation mode directly from /loop auto', async () => {
    await loopCommand.action!(context, 'auto');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: 'Loop automation set to auto.',
      }),
    );
  });
});
