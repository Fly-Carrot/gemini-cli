/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SharedFabricRegistry } from './sharedFabricRegistry.js';

describe('SharedFabricRegistry', () => {
  let tempDir: string;
  let skillsIndexPath: string;
  let domainMapPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-shared-fabric-'));
    skillsIndexPath = path.join(tempDir, 'skills_index.json');
    domainMapPath = path.join(tempDir, 'skills-domain-map.md');
    await fs.writeFile(domainMapPath, '# Domain Map\n', 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('does not surface skills whose indexed path escapes the trusted root', async () => {
    await fs.mkdir(path.join(tempDir, 'outside-skill'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'outside-skill', 'SKILL.md'),
      '# Outside skill\n',
      'utf-8',
    );
    await fs.writeFile(
      skillsIndexPath,
      JSON.stringify([
        {
          id: 'outside',
          path: '../outside-skill',
          name: 'Outside Skill',
          description: 'Should be rejected.',
        },
      ]),
      'utf-8',
    );

    const registry = new SharedFabricRegistry({
      globalRoot: tempDir,
      workspaceRoot: tempDir,
      skillsIndexPath,
      domainMapPath,
    });

    await expect(registry.searchSkills('outside')).resolves.toEqual([]);
    await expect(registry.findSkillByName('Outside Skill')).resolves.toBeNull();
    await expect(
      registry.loadSkillDefinition('Outside Skill'),
    ).resolves.toBeNull();
  });

  it('prefers domain-specific phrase matches over generic token matches', async () => {
    await fs.mkdir(path.join(tempDir, 'nature-data'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'fp-data-transforms'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(tempDir, 'nature-data', 'SKILL.md'),
      '# Nature data\n',
      'utf-8',
    );
    await fs.writeFile(
      path.join(tempDir, 'fp-data-transforms', 'SKILL.md'),
      '# FP data transforms\n',
      'utf-8',
    );
    await fs.writeFile(
      skillsIndexPath,
      JSON.stringify([
        {
          id: 'fp-data-transforms',
          path: 'fp-data-transforms',
          category: 'uncategorized',
          name: 'fp-data-transforms',
          description: 'Functional data transforms and pipelines.',
          source: 'nature-skills',
        },
        {
          id: 'nature-data',
          path: 'nature-data',
          category: 'research-data',
          name: 'nature-data',
          description:
            'Prepare Nature-ready Data Availability statements, repository plans, and FAIR metadata checks for journal submission.',
          source: 'nature-skills',
        },
      ]),
      'utf-8',
    );
    await fs.writeFile(
      domainMapPath,
      `## 翰林院 · 学术发表（Academic Publishing）
论文润色、科研图表、数据可用性声明与 FAIR 元数据整理。

**高频关键词**：nature, manuscript, data availability, fair, journal submission

**代表 Skills**：\`nature-data\`
`,
      'utf-8',
    );

    const registry = new SharedFabricRegistry({
      globalRoot: tempDir,
      workspaceRoot: tempDir,
      skillsIndexPath,
      domainMapPath,
    });

    const route = await registry.recommendSkills(
      'data availability statement for journal submission',
      4,
    );
    expect(route.domain?.label).toContain('学术发表');
    expect(route.skills[0]?.name).toBe('nature-data');
  });

  it('surfaces curated skill repos ahead of the larger catalog', async () => {
    const curatedRoot = path.join(
      tempDir,
      'skills',
      'curated',
      'current-workflow',
    );
    await fs.mkdir(path.join(curatedRoot, 'code-reviewer'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(curatedRoot, 'code-reviewer', 'SKILL.md'),
      `---
name: code-reviewer
description: Focused review workflow for the active Gemini-2 codebase.
risk: low
---
`,
      'utf-8',
    );
    await fs.mkdir(path.join(tempDir, 'skills'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'skills', 'sources.yaml'),
      `version: 1
sources:
  -
    id: "curated-current-workflow-skills"
    type: "curated_skill_repo"
    path: "${curatedRoot}"
    skill_count: 1
`,
      'utf-8',
    );
    await fs.writeFile(
      skillsIndexPath,
      JSON.stringify([
        {
          id: 'generic-review',
          path: 'generic-review',
          category: 'uncategorized',
          name: 'generic-review',
          description: 'Generic review guidance.',
          source: 'awesome-skills',
        },
      ]),
      'utf-8',
    );

    const registry = new SharedFabricRegistry({
      globalRoot: tempDir,
      workspaceRoot: tempDir,
      skillsIndexPath,
      domainMapPath,
    });

    const result = await registry.findSkillByName('code-reviewer');
    expect(result?.sourceId).toBe('curated-current-workflow-skills');
    expect(result?.description).toContain('Focused review workflow');
  });
});
