/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AutomationStrategyService,
  DEFAULT_AUTOMATION_STRATEGY,
} from './automationStrategyService.js';
import { createMockConfig } from '../test-utils/mockConfig.js';

describe('AutomationStrategyService', () => {
  let tempDir: string;
  let service: AutomationStrategyService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'gemini-automation-strategy-'),
    );
    const config = createMockConfig();
    config.storage.getProjectTempDir = () => tempDir;
    service = new AutomationStrategyService(config);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns defaults when no persisted state exists', async () => {
    const snapshot = await service.getSnapshot();

    expect(snapshot.exists).toBe(false);
    expect(snapshot.loopMode).toBe(DEFAULT_AUTOMATION_STRATEGY.loopMode);
    expect(snapshot.skillsMode).toBe(DEFAULT_AUTOMATION_STRATEGY.skillsMode);
    expect(snapshot.agentsMode).toBe(DEFAULT_AUTOMATION_STRATEGY.agentsMode);
  });

  it('persists loop, skills, and agents mode changes', async () => {
    await service.setLoopMode('full');
    await service.setSkillsMode('manual');
    const state = await service.setAgentsMode('full');

    expect(state.loopMode).toBe('full');
    expect(state.skillsMode).toBe('manual');
    expect(state.agentsMode).toBe('full');

    const snapshot = await service.getSnapshot();
    expect(snapshot.exists).toBe(true);
    expect(snapshot.loopMode).toBe('full');
    expect(snapshot.skillsMode).toBe('manual');
    expect(snapshot.agentsMode).toBe('full');
  });

  it('isolates automation state by session id', async () => {
    await service.setLoopMode('full');

    const otherConfig = createMockConfig({
      getSessionId: () => 'another-session',
    });
    otherConfig.storage.getProjectTempDir = () => tempDir;
    const otherService = new AutomationStrategyService(otherConfig);

    const otherSnapshot = await otherService.getSnapshot();
    expect(otherSnapshot.exists).toBe(false);
    expect(otherSnapshot.loopMode).toBe(DEFAULT_AUTOMATION_STRATEGY.loopMode);
    expect(otherSnapshot.statePath).not.toBe(
      (await service.getSnapshot()).statePath,
    );
  });

  it('falls back to defaults when the state file is malformed', async () => {
    await fs.mkdir(path.dirname(service.getStatePath()), { recursive: true });
    await fs.writeFile(service.getStatePath(), '{bad-json', 'utf-8');

    const snapshot = await service.getSnapshot();
    expect(snapshot.exists).toBe(false);
    expect(snapshot.loopMode).toBe(DEFAULT_AUTOMATION_STRATEGY.loopMode);
  });
});
