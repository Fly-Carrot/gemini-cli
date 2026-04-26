/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SessionStartSource,
  type Config,
  type ResumedSessionData,
} from '@google/gemini-cli-core';

export enum SessionRunMode {
  Acp = 'acp',
  Interactive = 'interactive',
  NonInteractive = 'non-interactive',
}

export interface SessionRunHandlers {
  onAcp: () => Promise<void>;
  onInteractive: () => Promise<void>;
  onNonInteractive: () => Promise<void>;
}

export interface PrepareNonInteractiveInputOptions {
  config: Pick<Config, 'getHookSystem'>;
  initialInput: string | undefined;
  isStdinTTY: boolean;
  readStdin: () => Promise<string | undefined>;
  resumedSessionData?: ResumedSessionData;
  onSystemMessage?: (message: string) => void;
}

export interface PreparedNonInteractiveInput {
  input: string | undefined;
  sessionStartSource: SessionStartSource;
}

/**
 * SessionOrchestrator is the first extraction of session routing from gemini.tsx.
 * It owns the mode decision and provides a stable seam for future session-runtime
 * features such as context budgeting and richer subagent/session coordination.
 */
export class SessionOrchestrator {
  constructor(
    private readonly config: Pick<Config, 'getAcpMode' | 'isInteractive'>,
  ) {}

  getMode(): SessionRunMode {
    if (this.config.getAcpMode()) {
      return SessionRunMode.Acp;
    }

    return this.config.isInteractive()
      ? SessionRunMode.Interactive
      : SessionRunMode.NonInteractive;
  }

  async run(handlers: SessionRunHandlers): Promise<void> {
    switch (this.getMode()) {
      case SessionRunMode.Acp:
        return handlers.onAcp();
      case SessionRunMode.Interactive:
        return handlers.onInteractive();
      case SessionRunMode.NonInteractive:
        return handlers.onNonInteractive();
      default:
        return undefined;
    }
  }
}

export async function prepareNonInteractiveInput(
  options: PrepareNonInteractiveInputOptions,
): Promise<PreparedNonInteractiveInput> {
  const {
    config,
    initialInput,
    isStdinTTY,
    readStdin,
    resumedSessionData,
    onSystemMessage,
  } = options;

  let input = initialInput;

  if (!isStdinTTY) {
    const stdinData = await readStdin();
    if (stdinData) {
      input = input ? `${stdinData}\n\n${input}` : stdinData;
    }
  }

  const sessionStartSource = resumedSessionData
    ? SessionStartSource.Resume
    : SessionStartSource.Startup;

  const hookSystem = config.getHookSystem();
  if (hookSystem) {
    const result = await hookSystem.fireSessionStartEvent(sessionStartSource);

    if (result?.systemMessage) {
      onSystemMessage?.(result.systemMessage);
    }

    const additionalContext = result?.getAdditionalContext();
    if (additionalContext) {
      const wrappedContext = `<hook_context>${additionalContext}</hook_context>`;
      input = input ? `${wrappedContext}\n\n${input}` : wrappedContext;
    }
  }

  return {
    input,
    sessionStartSource,
  };
}
