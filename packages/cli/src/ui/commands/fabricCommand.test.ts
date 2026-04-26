/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { fabricCommand } from './fabricCommand.js';
import { MessageType } from '../types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { CommandContext } from './types.js';
import { SharedFabricRegistry } from '../../services/sharedFabricRegistry.js';

describe('fabricCommand', () => {
  let context: CommandContext;

  beforeEach(() => {
    context = createMockCommandContext();
    vi.spyOn(SharedFabricRegistry.prototype, 'getStatus').mockResolvedValue({
      available: true,
      globalRoot: '/fabric',
      workspaceRoot: '/workspace',
      bootSequencePath: '/fabric/sync/boot-sequence.md',
      runtimeMapPath: '/fabric/sync/runtime-map.yaml',
      memoryRoutesPath: '/fabric/memory/routes.yaml',
      domainMapPath: '/fabric/domain.md',
      skillsIndexPath: '/skills/index.json',
      workspaceOverlayPath: '/workspace/.agents/sync/user-question-profile.md',
      bootSequenceExists: true,
      runtimeMapExists: true,
      memoryRoutesExists: true,
      domainMapExists: true,
      skillsIndexExists: true,
      workspaceOverlayExists: true,
      sources: [
        {
          id: 'awesome-skills',
          type: 'skill_repo',
          path: '/skills',
          skillCount: 1234,
        },
      ],
      indexedSkillCount: 1234,
      routedDomainCount: 6,
    });
    vi.spyOn(
      SharedFabricRegistry.prototype,
      'recommendSkills',
    ).mockResolvedValue({
      domain: {
        label: '兵部 · 工程（Engineering & Development）',
        summary: '代码实现、框架开发、前后端工程。',
        keywords: ['typescript'],
        representativeSkills: ['backend-architect'],
      },
      skills: [
        {
          name: 'backend-architect',
          description: 'Design backend systems',
          location: '/skills/backend-architect/SKILL.md',
          body: '',
        },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows shared-fabric status', async () => {
    await fabricCommand.action!(context, '');

    expect(context.ui.addItem).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: MessageType.INFO,
        text: 'Shared fabric detected and ready for Gemini-2.',
      }),
    );
    expect(context.ui.addItem).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        text: 'Global root: /fabric',
      }),
    );
  });

  it('routes a query to shared-fabric skills', async () => {
    const routeCmd = fabricCommand.subCommands!.find(
      (s) => s.name === 'route',
    )!;

    await routeCmd.action!(context, '实现一个 TypeScript 后端接口');

    expect(SharedFabricRegistry.prototype.recommendSkills).toHaveBeenCalledWith(
      '实现一个 TypeScript 后端接口',
      8,
    );
    expect(context.ui.addItem).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: MessageType.SKILLS_LIST,
        skills: [expect.objectContaining({ name: 'backend-architect' })],
      }),
    );
  });
});
