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
      storage: {
        getProjectTempDir: vi.fn().mockReturnValue(tempRoot),
      },
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
    expect(result.queryToSend).toContain('<shared_fabric_governance>');
    expect(result.queryToSend).toContain('<project_overlay');
    expect(result.queryToSend).toContain(
      'Gemini CLI architecture optimization',
    );
    expect(result.queryToSend).toContain('<shared_fabric_routing>');
    expect(result.queryToSend).toContain('Preferred agent candidate: reviewer');
    expect(result.queryToSend).toContain(
      'Delegation requirement: this request is complex.',
    );
    expect(result.activatedSkills).toEqual([
      expect.objectContaining({
        name: 'code-reviewer',
        loadedIntoSession: true,
      }),
    ]);
    expect(result.requiresDelegation).toBe(true);
    expect(result.notices.map((notice) => notice.text)).toEqual(
      expect.arrayContaining([
        'Loaded shared-fabric session context.',
        'Auto-loaded 1 shared-fabric skill.',
        'Delegation required via agent reviewer.',
      ]),
    );
    expect(geminiClient.addHistory).toHaveBeenCalledTimes(2);
    expect(skillManager.activateSkill).toHaveBeenCalledWith('code-reviewer');
    expect(workspaceContext.addDirectory).toHaveBeenCalledWith(skillDir);
  });

  it('auto-activates a trusted companion skill when it is complementary', async () => {
    const reviewDir = path.join(tempRoot, 'skills', 'code-reviewer');
    const testDir = path.join(tempRoot, 'skills', 'testing-patterns');
    await fs.mkdir(reviewDir, { recursive: true });
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(
      path.join(reviewDir, 'SKILL.md'),
      '# code-reviewer\n\nReview code carefully.\n',
      'utf-8',
    );
    await fs.writeFile(
      path.join(testDir, 'SKILL.md'),
      '# testing-patterns\n\nDesign strong tests.\n',
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
    const config = {
      getWorkingDir: vi.fn().mockReturnValue(workspaceRoot),
      storage: {
        getProjectTempDir: vi.fn().mockReturnValue(tempRoot),
      },
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
      domain: {
        label: 'Engineering',
        summary: 'Architecture and validation',
        keywords: ['review', 'test'],
        representativeSkills: ['code-reviewer', 'testing-patterns'],
      },
      skills: [
        {
          name: 'code-reviewer',
          description: 'Review architecture, behavior, and regression risk',
          location: path.join(reviewDir, 'SKILL.md'),
          body: '',
          score: 9,
          risk: 'low',
          sourceType: 'skill_repo',
          catalogSource: 'awesome-skills',
        },
        {
          name: 'testing-patterns',
          description: 'Design coverage and test strategy for changes',
          location: path.join(testDir, 'SKILL.md'),
          body: '',
          score: 7,
          risk: 'low',
          sourceType: 'skill_repo',
          catalogSource: 'awesome-skills',
        },
      ],
    });
    vi.spyOn(
      SharedFabricRegistry.prototype,
      'loadSkillDefinition',
    ).mockImplementation(async (name: string) => ({
      name,
      description: name === 'code-reviewer' ? 'Review code' : 'Testing help',
      location: path.join(
        name === 'code-reviewer' ? reviewDir : testDir,
        'SKILL.md',
      ),
      body:
        name === 'code-reviewer'
          ? 'Use a code review workflow.'
          : 'Use a testing workflow.',
      isBuiltin: false,
    }));

    const router = new SharedFabricAutoRouter(config, geminiClient);
    const result = await router.preparePrompt(
      'Review this refactor and strengthen the related tests',
      new AbortController().signal,
    );

    expect(result.activatedSkills.map((skill) => skill.name)).toEqual([
      'code-reviewer',
      'testing-patterns',
    ]);
    expect(result.notices.map((notice) => notice.text)).toContain(
      'Auto-loaded 2 shared-fabric skills.',
    );
    expect(geminiClient.addHistory).toHaveBeenCalledTimes(4);
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
      storage: {
        getProjectTempDir: vi.fn().mockReturnValue(tempRoot),
      },
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
    expect(first.queryToSend).toContain('<shared_fabric_governance>');
    expect(second.queryToSend).not.toContain('<global_shared_context');
    expect(second.queryToSend).toContain('<shared_fabric_governance>');
    expect(second.notices.map((notice) => notice.text)).not.toContain(
      'Loaded shared-fabric session context.',
    );
    expect(geminiClient.addHistory).not.toHaveBeenCalled();
  });

  it('does not auto-activate skills when skills mode is manual', async () => {
    await fs.mkdir(path.join(tempRoot, 'gemini-2'), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, 'gemini-2', 'automation-strategy.json'),
      JSON.stringify({
        loopMode: 'off',
        skillsMode: 'manual',
        agentsMode: 'auto',
        updatedAt: new Date().toISOString(),
      }),
      'utf-8',
    );

    const skillManager = {
      getSkill: vi.fn(),
      addSkills: vi.fn(),
      isSkillActive: vi.fn().mockReturnValue(false),
      activateSkill: vi.fn(),
      getSkills: vi.fn().mockReturnValue([]),
    };
    const config = {
      getWorkingDir: vi.fn().mockReturnValue(workspaceRoot),
      storage: {
        getProjectTempDir: vi.fn().mockReturnValue(tempRoot),
      },
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

    vi.spyOn(
      SharedFabricRegistry.prototype,
      'recommendSkills',
    ).mockResolvedValue({
      domain: undefined,
      skills: [
        {
          name: 'code-reviewer',
          description: 'Review code',
          location: '/shared/code-reviewer/SKILL.md',
          body: '',
          score: 9,
          risk: 'low',
        },
      ],
    });

    const geminiClient = {
      addHistory: vi.fn().mockResolvedValue(undefined),
    };
    const router = new SharedFabricAutoRouter(config, geminiClient);
    const result = await router.preparePrompt(
      'Review this refactor carefully',
      new AbortController().signal,
    );

    expect(result.activatedSkills).toEqual([]);
    expect(result.queryToSend).toContain('Skills policy: manual');
    expect(geminiClient.addHistory).not.toHaveBeenCalled();
  });

  it('requires subagent delegation in full agents mode when a suitable agent exists', async () => {
    await fs.mkdir(path.join(tempRoot, 'gemini-2'), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, 'gemini-2', 'automation-strategy.json'),
      JSON.stringify({
        loopMode: 'off',
        skillsMode: 'auto',
        agentsMode: 'full',
        updatedAt: new Date().toISOString(),
      }),
      'utf-8',
    );

    const config = {
      getWorkingDir: vi.fn().mockReturnValue(workspaceRoot),
      storage: {
        getProjectTempDir: vi.fn().mockReturnValue(tempRoot),
      },
      getSkillManager: vi.fn().mockReturnValue({
        getSkill: vi.fn(),
        addSkills: vi.fn(),
        isSkillActive: vi.fn().mockReturnValue(false),
        getSkills: vi.fn().mockReturnValue([]),
      }),
      getAgentRegistry: vi.fn().mockReturnValue({
        getAllDefinitions: vi.fn().mockReturnValue([
          {
            name: 'architect-reviewer',
            displayName: 'Architect Reviewer',
            description: 'Architecture review and implementation planning',
          },
        ]),
      }),
      getMessageBus: vi.fn().mockReturnValue({}),
      getModel: vi.fn().mockReturnValue('gemini-test'),
      getWorkspaceContext: vi.fn().mockReturnValue({
        addDirectory: vi.fn(),
      }),
    } as unknown as Config;

    vi.spyOn(
      SharedFabricRegistry.prototype,
      'recommendSkills',
    ).mockResolvedValue({
      domain: undefined,
      skills: [],
    });

    const geminiClient = {
      addHistory: vi.fn().mockResolvedValue(undefined),
    };
    const router = new SharedFabricAutoRouter(config, geminiClient);
    const result = await router.preparePrompt(
      'Please analyze this architecture migration and produce a staged refactor plan',
      new AbortController().signal,
    );

    expect(result.requiresDelegation).toBe(true);
    expect(result.queryToSend).toContain('Agents policy: full');
    expect(result.queryToSend).toContain(
      'You MUST call invoke_agent with agent_name="architect-reviewer"',
    );
  });
});
