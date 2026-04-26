/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  SessionOrchestrator,
  SessionRunMode,
  prepareNonInteractiveInput,
} from './sessionOrchestrator.js';
import {
  SessionStartSource,
  type Config,
  type ResumedSessionData,
} from '@google/gemini-cli-core';

describe('sessionOrchestrator', () => {
  it('routes ACP mode before interactive mode', () => {
    const orchestrator = new SessionOrchestrator({
      getAcpMode: () => true,
      isInteractive: () => true,
    } as Pick<Config, 'getAcpMode' | 'isInteractive'>);

    expect(orchestrator.getMode()).toBe(SessionRunMode.Acp);
  });

  it('routes interactive mode when ACP is disabled', () => {
    const orchestrator = new SessionOrchestrator({
      getAcpMode: () => false,
      isInteractive: () => true,
    } as Pick<Config, 'getAcpMode' | 'isInteractive'>);

    expect(orchestrator.getMode()).toBe(SessionRunMode.Interactive);
  });

  it('routes non-interactive mode otherwise', () => {
    const orchestrator = new SessionOrchestrator({
      getAcpMode: () => false,
      isInteractive: () => false,
    } as Pick<Config, 'getAcpMode' | 'isInteractive'>);

    expect(orchestrator.getMode()).toBe(SessionRunMode.NonInteractive);
  });

  it('dispatches the matching handler', async () => {
    const orchestrator = new SessionOrchestrator({
      getAcpMode: () => false,
      isInteractive: () => false,
    } as Pick<Config, 'getAcpMode' | 'isInteractive'>);

    const handlers = {
      onAcp: vi.fn(),
      onInteractive: vi.fn(),
      onNonInteractive: vi.fn(),
    };

    await orchestrator.run(handlers);

    expect(handlers.onNonInteractive).toHaveBeenCalledOnce();
    expect(handlers.onAcp).not.toHaveBeenCalled();
    expect(handlers.onInteractive).not.toHaveBeenCalled();
  });
});

describe('prepareNonInteractiveInput', () => {
  it('prepends stdin to the prompt when stdin is piped', async () => {
    const result = await prepareNonInteractiveInput({
      config: {
        getHookSystem: () => undefined,
      } as Pick<Config, 'getHookSystem'>,
      initialInput: 'question',
      isStdinTTY: false,
      readStdin: vi.fn().mockResolvedValue('stdin text'),
    });

    expect(result.input).toBe('stdin text\n\nquestion');
    expect(result.sessionStartSource).toBe(SessionStartSource.Startup);
  });

  it('does not read stdin when running on a tty', async () => {
    const readStdin = vi.fn();

    await prepareNonInteractiveInput({
      config: {
        getHookSystem: () => undefined,
      } as Pick<Config, 'getHookSystem'>,
      initialInput: 'question',
      isStdinTTY: true,
      readStdin,
    });

    expect(readStdin).not.toHaveBeenCalled();
  });

  it('adds session-start hook context and emits system messages', async () => {
    const fireSessionStartEvent = vi.fn().mockResolvedValue({
      systemMessage: 'hook warning',
      getAdditionalContext: () => 'extra context',
    });
    const onSystemMessage = vi.fn();

    const result = await prepareNonInteractiveInput({
      config: {
        getHookSystem: () =>
          ({
            fireSessionStartEvent,
          }) as unknown as NonNullable<ReturnType<Config['getHookSystem']>>,
      } as Pick<Config, 'getHookSystem'>,
      initialInput: 'question',
      isStdinTTY: true,
      readStdin: vi.fn(),
      onSystemMessage,
    });

    expect(fireSessionStartEvent).toHaveBeenCalledWith(
      SessionStartSource.Startup,
    );
    expect(onSystemMessage).toHaveBeenCalledWith('hook warning');
    expect(result.input).toBe(
      '<hook_context>extra context</hook_context>\n\nquestion',
    );
  });

  it('uses resume as the session start source for resumed sessions', async () => {
    const fireSessionStartEvent = vi.fn().mockResolvedValue(undefined);

    const resumedSessionData = {} as ResumedSessionData;
    const result = await prepareNonInteractiveInput({
      config: {
        getHookSystem: () =>
          ({
            fireSessionStartEvent,
          }) as unknown as NonNullable<ReturnType<Config['getHookSystem']>>,
      } as Pick<Config, 'getHookSystem'>,
      initialInput: undefined,
      isStdinTTY: true,
      readStdin: vi.fn(),
      resumedSessionData,
    });

    expect(fireSessionStartEvent).toHaveBeenCalledWith(
      SessionStartSource.Resume,
    );
    expect(result.sessionStartSource).toBe(SessionStartSource.Resume);
  });
});
