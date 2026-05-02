/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeCommand } from './runtimeCommand.js';
import { MessageType } from '../types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { CommandContext } from './types.js';
import {
  QueryRuntimeService,
  type QueryRuntimeSnapshot,
} from '../../services/queryRuntimeService.js';

describe('runtimeCommand', () => {
  let context: CommandContext;
  let snapshot: QueryRuntimeSnapshot;

  beforeEach(() => {
    context = createMockCommandContext({
      services: {
        agentContext: {
          config: {
            getWorkingDir: () => '/workspace',
          },
          geminiClient: {
            tryCompressChat: vi.fn().mockResolvedValue({
              originalTokenCount: 1000,
              newTokenCount: 200,
              compressionStatus: 'success',
            }),
          },
        },
      },
      session: {
        stats: {
          sessionId: 'session-1',
          sessionStartTime: new Date(),
          lastPromptTokenCount: 321,
          promptCount: 5,
          metrics: {
            models: {},
            tools: {
              totalCalls: 0,
              totalSuccess: 0,
              totalFail: 0,
              totalDurationMs: 0,
              totalDecisions: { accept: 0, reject: 0, modify: 0 },
              byName: {},
            },
            files: {
              totalLinesAdded: 0,
              totalLinesRemoved: 0,
            },
          },
        },
      },
    });

    snapshot = {
      sessionId: 'session-1',
      model: 'gemini-test',
      promptCount: 5,
      lastPromptTokenCount: 321,
      tokenLimit: 1000,
      contextUsagePercent: 32.1,
      compressionThreshold: 0.7,
      compressionThresholdTokenCount: 700,
      compressionThresholdUsagePercent: 45.9,
      activeSkillNames: ['context-compression', 'code-reviewer'],
      discoveredAgentNames: ['researcher', 'reviewer'],
      memory: {
        jitEnabled: true,
        loadedPathCount: 3,
        loadedPaths: ['/workspace/GEMINI.md'],
        globalChars: 12,
        extensionChars: 13,
        projectChars: 14,
        userProjectChars: 15,
      },
      checkpoints: {
        enabled: true,
        directory: '/workspace/.gemini/checkpoints',
        count: 2,
      },
      sharedFabric: {
        available: true,
        indexedSkillCount: 100,
        routedDomainCount: 6,
        workspaceOverlayPath:
          '/workspace/.agents/sync/user-question-profile.md',
        workspaceOverlayExists: true,
        workspaceRoot: '/workspace',
        globalRoot: '/fabric',
      },
      loop: {
        statePath: '/workspace/.gemini/tmp/loop-runtime.json',
        exists: true,
        status: 'active',
        goal: 'Ship a stable release',
        iteration: 3,
        maxIterations: 12,
        updatedAt: '2026-04-27T00:00:00.000Z',
        lastSummary: 'Checkpoint complete',
        stopCategory: 'review-required',
        sessionId: 'session-1',
        autoRunEnabled: true,
      },
      automation: {
        loopMode: 'auto',
        skillsMode: 'auto',
        agentsMode: 'full',
      },
      bridge: {
        snapshotPath: '/workspace/.gemini/tmp/query-runtime-bridge.json',
        updatedAt: '2026-04-27T00:00:00.000Z',
      },
    };

    vi.spyOn(
      QueryRuntimeService.prototype,
      'captureSnapshot',
    ).mockResolvedValue(snapshot);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows runtime status and bridge path', async () => {
    await runtimeCommand.action!(context, '');

    expect(context.ui.addItem).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: MessageType.INFO,
        text: 'Gemini-2 QueryRuntime captured for session session-1.',
      }),
    );
    expect(context.ui.addItem).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        text: 'Automation: loop auto · skills auto · agents full.',
      }),
    );
    expect(context.ui.addItem).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        text: expect.stringContaining('Skills and agents: 2 active skills'),
      }),
    );
    expect(context.ui.addItem).toHaveBeenNthCalledWith(
      6,
      expect.objectContaining({
        text: 'Loop runtime: active · iteration 3/12 · autorun on.',
        secondaryText: expect.stringContaining(
          'stop category: review-required',
        ),
      }),
    );
  });

  it('writes the bridge snapshot explicitly', async () => {
    const bridgeCmd = runtimeCommand.subCommands!.find(
      (subCommand) => subCommand.name === 'bridge',
    )!;

    await bridgeCmd.action!(context, '');

    expect(QueryRuntimeService.prototype.captureSnapshot).toHaveBeenCalled();
    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Wrote Gemini-2 runtime bridge snapshot.',
      }),
    );
  });

  it('runs runtime compaction and refreshes the bridge snapshot', async () => {
    const compactCmd = runtimeCommand.subCommands!.find(
      (subCommand) => subCommand.name === 'compact',
    )!;

    await compactCmd.action!(context, '');

    expect(
      context.services.agentContext?.geminiClient?.tryCompressChat,
    ).toHaveBeenCalled();
    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: 'QueryRuntime bridge refreshed after compaction.',
      }),
      expect.any(Number),
    );
  });
});
