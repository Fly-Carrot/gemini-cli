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
});
