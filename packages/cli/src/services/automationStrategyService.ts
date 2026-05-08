/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Config } from '@google/gemini-cli-core';

export type LoopAutomationMode = 'off' | 'auto' | 'full';
export type SkillAutomationMode = 'manual' | 'auto' | 'full';
export type AgentAutomationMode = 'manual' | 'auto' | 'full';
export type ShellReplyMode = 'manual' | 'suggest' | 'auto';

export interface AutomationStrategyState {
  loopMode: LoopAutomationMode;
  skillsMode: SkillAutomationMode;
  agentsMode: AgentAutomationMode;
  shellReplyMode: ShellReplyMode;
  updatedAt: string;
}

export interface AutomationStrategySnapshot extends AutomationStrategyState {
  statePath: string;
  exists: boolean;
}

export const DEFAULT_AUTOMATION_STRATEGY: Omit<
  AutomationStrategyState,
  'updatedAt'
> = {
  loopMode: isLoopMode(process.env['GEMINI2_DEFAULT_LOOP_MODE'])
    ? process.env['GEMINI2_DEFAULT_LOOP_MODE']
    : 'off',
  skillsMode: isSkillsMode(process.env['GEMINI2_DEFAULT_SKILLS_MODE'])
    ? process.env['GEMINI2_DEFAULT_SKILLS_MODE']
    : 'auto',
  agentsMode: isAgentsMode(process.env['GEMINI2_DEFAULT_AGENTS_MODE'])
    ? process.env['GEMINI2_DEFAULT_AGENTS_MODE']
    : 'auto',
  shellReplyMode: isShellReplyMode(
    process.env['GEMINI2_DEFAULT_SHELL_REPLY_MODE'],
  )
    ? process.env['GEMINI2_DEFAULT_SHELL_REPLY_MODE']
    : 'suggest',
};

function sanitizeSessionPathSegment(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return 'session-unknown';
  }

  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export function getGemini2SessionStateDir(config: Config): string {
  return path.join(
    config.storage.getProjectTempDir(),
    'gemini-2',
    'sessions',
    sanitizeSessionPathSegment(config.getSessionId()),
  );
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(
      tempPath,
      `${JSON.stringify(value, null, 2)}\n`,
      'utf-8',
    );
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.unlink(tempPath).catch(() => undefined);
  }
}

function isLoopMode(value: unknown): value is LoopAutomationMode {
  return value === 'off' || value === 'auto' || value === 'full';
}

function isSkillsMode(value: unknown): value is SkillAutomationMode {
  return value === 'manual' || value === 'auto' || value === 'full';
}

function isAgentsMode(value: unknown): value is AgentAutomationMode {
  return value === 'manual' || value === 'auto' || value === 'full';
}

function isShellReplyMode(value: unknown): value is ShellReplyMode {
  return value === 'manual' || value === 'suggest' || value === 'auto';
}

function parseAutomationStrategyState(
  value: unknown,
): AutomationStrategyState | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const candidate = value as Partial<
    Record<keyof AutomationStrategyState, unknown>
  >;
  if (
    !isLoopMode(candidate.loopMode) ||
    !isSkillsMode(candidate.skillsMode) ||
    !isAgentsMode(candidate.agentsMode) ||
    !isShellReplyMode(candidate.shellReplyMode) ||
    typeof candidate.updatedAt !== 'string'
  ) {
    return null;
  }

  return {
    loopMode: candidate.loopMode,
    skillsMode: candidate.skillsMode,
    agentsMode: candidate.agentsMode,
    shellReplyMode: candidate.shellReplyMode,
    updatedAt: candidate.updatedAt,
  };
}

function buildState(
  partial?: Partial<AutomationStrategyState>,
): AutomationStrategyState {
  return {
    ...DEFAULT_AUTOMATION_STRATEGY,
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

export class AutomationStrategyService {
  constructor(private readonly config: Config) {}

  getStatePath(): string {
    return path.join(
      getGemini2SessionStateDir(this.config),
      'automation-strategy.json',
    );
  }

  async getSnapshot(): Promise<AutomationStrategySnapshot> {
    const state = await this.loadState();
    return {
      ...(state ?? buildState()),
      statePath: this.getStatePath(),
      exists: !!state,
    };
  }

  async getState(): Promise<AutomationStrategyState> {
    return (await this.loadState()) ?? buildState();
  }

  async setLoopMode(loopMode: LoopAutomationMode) {
    return this.updateState({ loopMode });
  }

  async setSkillsMode(skillsMode: SkillAutomationMode) {
    return this.updateState({ skillsMode });
  }

  async setAgentsMode(agentsMode: AgentAutomationMode) {
    return this.updateState({ agentsMode });
  }

  async setShellReplyMode(shellReplyMode: ShellReplyMode) {
    return this.updateState({ shellReplyMode });
  }

  async updateState(
    patch: Partial<
      Pick<
        AutomationStrategyState,
        'loopMode' | 'skillsMode' | 'agentsMode' | 'shellReplyMode'
      >
    >,
  ): Promise<AutomationStrategyState> {
    const current = await this.getState();
    const next = buildState({
      ...current,
      ...patch,
    });
    await this.writeState(next);
    return next;
  }

  private async loadState(): Promise<AutomationStrategyState | null> {
    try {
      const contents = await fs.readFile(this.getStatePath(), 'utf-8');
      return parseAutomationStrategyState(JSON.parse(contents));
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return null;
      }
      if (error instanceof SyntaxError) {
        return null;
      }
      throw error;
    }
  }

  private async writeState(state: AutomationStrategyState): Promise<void> {
    await writeJsonFileAtomic(this.getStatePath(), state);
  }
}

export function describeLoopMode(mode: LoopAutomationMode): string {
  switch (mode) {
    case 'full':
      return 'Full loop automation. Long tasks default to six-step execution and keep going without approval checkpoints unless hard-blocked.';
    case 'auto':
      return 'Semi-automatic looping. Long tasks default to six-step execution and continue on their own, but should pause for meaningful human review points.';
    case 'off':
    default:
      return 'Loop automation is off. Use manual loop commands when you explicitly want a long-horizon task runner.';
  }
}

export function describeSkillsMode(mode: SkillAutomationMode): string {
  switch (mode) {
    case 'full':
      return 'Skill routing is mandatory. Gemini-2 should select the most suitable shared-fabric skill set before working.';
    case 'manual':
      return 'Manual skill mode. Gemini-2 will not auto-load skills; use /skills use or explicit skill names yourself.';
    case 'auto':
    default:
      return 'Adaptive skill routing. Gemini-2 will decide when skill help is useful, and auto-load only high-confidence matches.';
  }
}

export function describeAgentsMode(mode: AgentAutomationMode): string {
  switch (mode) {
    case 'full':
      return 'Agent delegation is mandatory for suitable tasks. Gemini-2 should pick a fitting subagent and call it explicitly.';
    case 'manual':
      return 'Manual agent mode. Gemini-2 will not auto-route to subagents; use /agents task yourself when you want delegation.';
    case 'auto':
    default:
      return 'Adaptive agent routing. Gemini-2 will recommend or use subagents when the task clearly benefits from delegation.';
  }
}

export function describeShellReplyMode(mode: ShellReplyMode): string {
  switch (mode) {
    case 'auto':
      return 'Automatic shell replies for clearly low-risk prompts such as plain Enter confirmations or safe yes/no continuations. Ambiguous prompts still pause for review.';
    case 'manual':
      return 'Manual shell reply mode. Gemini-2 will detect interactive prompts but leave all replies to you.';
    case 'suggest':
    default:
      return 'Suggested shell reply mode. Gemini-2 will detect interactive shell prompts and propose safe replies without sending them automatically.';
  }
}
