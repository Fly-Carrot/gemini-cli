/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoopRuntimeService } from './loopRuntimeService.js';
import { createMockConfig } from '../test-utils/mockConfig.js';

describe('LoopRuntimeService', () => {
  let tempDir: string;
  let service: LoopRuntimeService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-loop-runtime-'));
    const config = createMockConfig({
      getSessionId: () => 'session-loop-runtime',
      getWorkingDir: () => '/workspace',
    });
    config.storage.getProjectTempDir = () => tempDir;
    service = new LoopRuntimeService(config, '/workspace');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('continues autorun when a normal checkpoint response arrives', async () => {
    await service.startLoop('Ship loop mode', 3, true);
    await service.beginIteration();

    const outcome = await service.reconcileAssistantResponse(`
1. Iteration objective
something
5. Checkpoint summary
Loop runtime landed cleanly.
6. Next step
Keep going
`);

    expect(outcome.action).toBe('continue');
    expect(outcome.summary).toBe('Loop runtime landed cleanly.');
    expect(outcome.state.autoRunEnabled).toBe(true);
  });

  it('completes the loop when LOOP_COMPLETE is emitted', async () => {
    await service.startLoop('Finish the task', 3, true);
    await service.beginIteration();

    const outcome = await service.reconcileAssistantResponse(
      'LOOP_COMPLETE: Everything is done.',
    );

    expect(outcome.action).toBe('completed');
    expect(outcome.state.status).toBe('completed');
    expect(outcome.state.autoRunEnabled).toBe(false);
  });

  it('pauses autorun when the model reports blockage', async () => {
    await service.startLoop('Debug the blocker', 3, true);
    await service.beginIteration();

    const outcome = await service.reconcileAssistantResponse(
      'LOOP_BLOCKED: Need a credential refresh.',
    );

    expect(outcome.action).toBe('blocked');
    expect(outcome.state.status).toBe('paused');
    expect(outcome.state.autoRunEnabled).toBe(false);
    expect(outcome.state.stopCategory).toBe('blocked');
  });

  it('pauses autorun for explicit review checkpoints', async () => {
    await service.startLoop('Review the rollout', 3, true);
    await service.beginIteration();

    const outcome = await service.reconcileAssistantResponse(
      'LOOP_REVIEW_REQUIRED: Need approval before changing deployment defaults.',
    );

    expect(outcome.action).toBe('review');
    expect(outcome.state.status).toBe('paused');
    expect(outcome.state.stopCategory).toBe('review-required');
  });

  it('pauses autorun when explicit agent delegation is required', async () => {
    await service.startLoop('Split the task across agents', 3, true);
    await service.beginIteration();

    const outcome = await service.reconcileAssistantResponse(
      'AGENT_DELEGATION_REQUIRED: Need a reviewer subagent before continuing.',
    );

    expect(outcome.action).toBe('delegation');
    expect(outcome.state.status).toBe('paused');
    expect(outcome.state.stopCategory).toBe('delegation-required');
  });

  it('isolates loop state by session id', async () => {
    await service.startLoop('Ship loop mode', 3, true);

    const otherConfig = createMockConfig({
      getSessionId: () => 'session-loop-runtime-other',
      getWorkingDir: () => '/workspace',
    });
    otherConfig.storage.getProjectTempDir = () => tempDir;
    const otherService = new LoopRuntimeService(otherConfig, '/workspace');

    const otherSnapshot = await otherService.getSnapshot();
    expect(otherSnapshot.exists).toBe(false);
    expect(otherSnapshot.status).toBe('idle');
    expect(otherSnapshot.statePath).not.toBe(
      (await service.getSnapshot()).statePath,
    );
  });

  it('treats malformed state as absent', async () => {
    await fs.mkdir(path.dirname(service.getStatePath()), { recursive: true });
    await fs.writeFile(service.getStatePath(), '{bad-json', 'utf-8');

    const snapshot = await service.getSnapshot();
    expect(snapshot.exists).toBe(false);
    expect(snapshot.status).toBe('idle');
  });
});
