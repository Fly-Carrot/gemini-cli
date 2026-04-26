/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config, SkillDefinition } from '@google/gemini-cli-core';
import { SharedFabricAutoRouter } from './sharedFabricAutoRouter.js';
import {
  SharedFabricRegistry,
  type SharedFabricSkillCandidate,
} from './sharedFabricRegistry.js';

describe('SharedFabricAutoRouter', () => {
  let tempRoot: string;
  let fabricRoot: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini2-router-'));
    fabricRoot = path.join(tempRoot, 'global-agent-fabric');
    workspaceRoot = path.join(tempRoot, 'workspace');

    process.env['GEMINI2_SHARED_FABRIC_ROOT'] = fabricRoot;

    await fs.mkdir(path.join(fabricRoot, 'sync'), { recursive: true });
    await fs.mkdir(path.join(fabricRoot, 'memory'), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, '.agents', 'sync'), {
      recursive: true,
    });

    await fs.writeFile(
      path.join(fabricRoot, 'sync', 'runtime-map.yaml'),
      [
        'version: 1',
        'runtimes:',
        '  codex:',
        '    preferred_bootstrap_order:',
        '      - "/fabric/rules/global/gemini-global.md"',
        '      - "/fabric/projects/registry.yaml"',
        '      - "/fabric/mcp/servers.yaml"',
        '      - "/fabric/skills/sources.yaml"',
        '',
      ].join('\n'),
      'utf-8',
    );
    await fs.writeFile(
      path.join(fabricRoot, 'memory', 'user-question-profile.md'),
      '# User Question Profile\n\n## Response Preferences\n\n- Chinese responses\n',
      'utf-8',
    );
    await fs.writeFile(
      path.join(workspaceRoot, '.agents', 'sync', 'user-question-profile.md'),
      '# Workspace User Question Profile\n\n## Core Focus Points\n\n- Gemini CLI architecture optimization\n',
      'utf-8',
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env['GEMINI2_SHARED_FABRIC_ROOT'];
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('injects shared-fabric context and auto-activates a routed skill', async () => {
    const skillDir = path.join(tempRoot, 'skills', 'code-reviewer');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '# code-reviewer\n\nReview code carefully.\n',
      'utf-8',
    );
    await fs.writeFile(
      path.join(skillDir, 'checklist.md'),
      '- review\n',
      'utf-8',
    );

    const loadedSkills = new Map<string, SkillDefinition>();
    const activeSkills = new Set<string>();
    const skillManager = {
      getSkill: vi.fn((name: string) => loadedSkills.get(name)),
      addSkills: vi.fn((skills: SkillDefinition[]) => {
        for (const skill of skills) {
          loadedSkills.set(skill.name, skill);
        }
      }),
      isSkillActive: vi.fn((name: string) => activeSkills.has(name)),
      activateSkill: vi.fn((name: string) => {
        activeSkills.add(name);
      }),
      getSkills: vi.fn(() => Array.from(loadedSkills.values())),
    };
    const agentRegistry = {
      getAllDefinitions: vi.fn().mockReturnValue([
        {
          name: 'reviewer',
          displayName: 'Reviewer',
          description: 'Review code and architecture changes',
        },
      ]),
    };
    const workspaceContext = {
      addDirectory: vi.fn(),
    };
    const config = {
      getWorkingDir: vi.fn().mockReturnValue(workspaceRoot),
      getSkillManager: vi.fn().mockReturnValue(skillManager),
      getAgentRegistry: vi.fn().mockReturnValue(agentRegistry),
      getMessageBus: vi.fn().mockReturnValue({}),
      getModel: vi.fn().mockReturnValue('gemini-test'),
      getWorkspaceContext: vi.fn().mockReturnValue(workspaceContext),
    } as unknown as Config;
    const geminiClient = {
      addHistory: vi.fn().mockResolvedValue(undefined),
    };

    const routedSkill: SharedFabricSkillCandidate = {
      name: 'code-reviewer',
      description: 'Review code',
      location: path.join(skillDir, 'SKILL.md'),
      body: '',
      score: 9,
      risk: 'low',
    };

    vi.spyOn(
      SharedFabricRegistry.prototype,
      'recommendSkills',
    ).mockResolvedValue({
      domain: {
        label: 'Code Review',
        summary: 'Review-focused skills',
        keywords: ['review'],
        representativeSkills: ['code-reviewer'],
      },
      skills: [routedSkill],
    });
    vi.spyOn(
      SharedFabricRegistry.prototype,
      'loadSkillDefinition',
    ).mockResolvedValue({
      name: 'code-reviewer',
      description: 'Review code',
      location: path.join(skillDir, 'SKILL.md'),
      body: 'Use a code review workflow.',
      isBuiltin: false,
    });

    const router = new SharedFabricAutoRouter(config, geminiClient);
    const result = await router.preparePrompt(
      'Please review this architecture change',
      new AbortController().signal,
    );

    expect(result.queryToSend).toContain('<shared_fabric_context>');
    expect(result.queryToSend).toContain('<project_overlay');
    expect(result.queryToSend).toContain(
      'Gemini CLI architecture optimization',
    );
    expect(result.queryToSend).toContain('<shared_fabric_routing>');
    expect(result.queryToSend).toContain('Preferred agent candidate: reviewer');
    expect(result.activatedSkills).toEqual([
      expect.objectContaining({
        name: 'code-reviewer',
        loadedIntoSession: true,
      }),
    ]);
    expect(result.notices.map((notice) => notice.text)).toEqual(
      expect.arrayContaining([
        'Loaded shared-fabric session context.',
        'Auto-loaded 1 shared-fabric skill.',
        'Auto-routed agent hint: reviewer.',
      ]),
    );
    expect(geminiClient.addHistory).toHaveBeenCalledTimes(2);
    expect(skillManager.activateSkill).toHaveBeenCalledWith('code-reviewer');
    expect(workspaceContext.addDirectory).toHaveBeenCalledWith(skillDir);
  });

  it('seeds global session context only once and avoids duplicate skill activation', async () => {
    const skillManager = {
      getSkill: vi.fn().mockReturnValue({
        name: 'code-reviewer',
        description: 'Review code',
        location: path.join(tempRoot, 'skills', 'code-reviewer', 'SKILL.md'),
        body: 'Use a code review workflow.',
      }),
      addSkills: vi.fn(),
      isSkillActive: vi.fn().mockReturnValue(true),
      activateSkill: vi.fn(),
      getSkills: vi.fn().mockReturnValue([]),
    };
    const config = {
      getWorkingDir: vi.fn().mockReturnValue(workspaceRoot),
      getSkillManager: vi.fn().mockReturnValue(skillManager),
      getAgentRegistry: vi.fn().mockReturnValue({
        getAllDefinitions: vi.fn().mockReturnValue([]),
      }),
      getMessageBus: vi.fn().mockReturnValue({}),
      getModel: vi.fn().mockReturnValue('gemini-test'),
      getWorkspaceContext: vi.fn().mockReturnValue({
        addDirectory: vi.fn(),
      }),
    } as unknown as Config;
    const geminiClient = {
      addHistory: vi.fn().mockResolvedValue(undefined),
    };

    vi.spyOn(
      SharedFabricRegistry.prototype,
      'recommendSkills',
    ).mockResolvedValue({
      domain: undefined,
      skills: [
        {
          name: 'code-reviewer',
          description: 'Review code',
          location: path.join(tempRoot, 'skills', 'code-reviewer', 'SKILL.md'),
          body: '',
          score: 9,
          risk: 'low',
        },
      ],
    });

    const router = new SharedFabricAutoRouter(config, geminiClient);
    const first = await router.preparePrompt(
      'Review this change please',
      new AbortController().signal,
    );
    const second = await router.preparePrompt(
      'Review another change please',
      new AbortController().signal,
    );

    expect(first.queryToSend).toContain('<global_shared_context');
    expect(second.queryToSend).not.toContain('<global_shared_context');
    expect(second.notices.map((notice) => notice.text)).not.toContain(
      'Loaded shared-fabric session context.',
    );
    expect(geminiClient.addHistory).not.toHaveBeenCalled();
  });
});
