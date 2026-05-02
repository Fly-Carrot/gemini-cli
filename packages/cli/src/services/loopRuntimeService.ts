/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Config } from '@google/gemini-cli-core';
import {
  AutomationStrategyService,
  type AutomationStrategyState,
  getGemini2SessionStateDir,
  type LoopAutomationMode,
  writeJsonFileAtomic,
} from './automationStrategyService.js';

export type LoopRuntimeStatus = 'idle' | 'active' | 'paused' | 'completed';
export type LoopStopCategory =
  | 'manual'
  | 'blocked'
  | 'review-required'
  | 'delegation-required'
  | 'iteration-limit'
  | 'empty-output';

export interface LoopRuntimeState {
  goal: string;
  status: Exclude<LoopRuntimeStatus, 'idle'>;
  iteration: number;
  createdAt: string;
  updatedAt: string;
  workspaceRoot: string;
  sessionId: string;
  maxIterations: number;
  lastPrompt?: string;
  lastSummary?: string;
  stopReason?: string;
  stopCategory?: LoopStopCategory;
  completionSummary?: string;
  autoRunEnabled?: boolean;
}

export interface LoopRuntimeSnapshot {
  statePath: string;
  exists: boolean;
  status: LoopRuntimeStatus;
  goal?: string;
  iteration: number;
  maxIterations?: number;
  updatedAt?: string;
  lastSummary?: string;
  stopReason?: string;
  stopCategory?: LoopStopCategory;
  sessionId?: string;
  autoRunEnabled?: boolean;
  completionSummary?: string;
  loopMode?: LoopAutomationMode;
}

interface BeginIterationOptions {
  guidance?: string;
  resume?: boolean;
}

export interface LoopResponseOutcome {
  action:
    | 'continue'
    | 'completed'
    | 'blocked'
    | 'review'
    | 'delegation'
    | 'paused'
    | 'idle';
  state: LoopRuntimeState;
  summary?: string;
  reason?: string;
}

const DEFAULT_MAX_ITERATIONS = 12;

function isLoopRuntimeStatus(
  value: unknown,
): value is LoopRuntimeState['status'] {
  return value === 'active' || value === 'paused' || value === 'completed';
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isLoopStopCategory(value: unknown): value is LoopStopCategory {
  return (
    value === 'manual' ||
    value === 'blocked' ||
    value === 'review-required' ||
    value === 'delegation-required' ||
    value === 'iteration-limit' ||
    value === 'empty-output'
  );
}

function parseLoopRuntimeState(value: unknown): LoopRuntimeState | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const candidate = value as Partial<Record<keyof LoopRuntimeState, unknown>>;
  if (
    typeof candidate.goal !== 'string' ||
    !isLoopRuntimeStatus(candidate.status) ||
    typeof candidate.iteration !== 'number' ||
    typeof candidate.createdAt !== 'string' ||
    typeof candidate.updatedAt !== 'string' ||
    typeof candidate.workspaceRoot !== 'string' ||
    typeof candidate.sessionId !== 'string' ||
    typeof candidate.maxIterations !== 'number'
  ) {
    return null;
  }

  return {
    goal: candidate.goal,
    status: candidate.status,
    iteration: candidate.iteration,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    workspaceRoot: candidate.workspaceRoot,
    sessionId: candidate.sessionId,
    maxIterations: candidate.maxIterations,
    lastPrompt:
      typeof candidate.lastPrompt === 'string'
        ? candidate.lastPrompt
        : undefined,
    lastSummary:
      typeof candidate.lastSummary === 'string'
        ? candidate.lastSummary
        : undefined,
    stopReason:
      typeof candidate.stopReason === 'string'
        ? candidate.stopReason
        : undefined,
    stopCategory: isLoopStopCategory(candidate.stopCategory)
      ? candidate.stopCategory
      : undefined,
    completionSummary:
      typeof candidate.completionSummary === 'string'
        ? candidate.completionSummary
        : undefined,
    autoRunEnabled:
      typeof candidate.autoRunEnabled === 'boolean'
        ? candidate.autoRunEnabled
        : undefined,
  };
}

export class LoopRuntimeService {
  private readonly automationStrategies: AutomationStrategyService;

  constructor(
    private readonly config: Config,
    private readonly workspaceRoot: string,
  ) {
    this.automationStrategies = new AutomationStrategyService(config);
  }

  getStatePath(): string {
    return path.join(
      getGemini2SessionStateDir(this.config),
      'loop-runtime.json',
    );
  }

  async getSnapshot(): Promise<LoopRuntimeSnapshot> {
    const state = await this.loadState();
    const strategy = await this.automationStrategies.getState();
    if (!state) {
      return {
        statePath: this.getStatePath(),
        exists: false,
        status: 'idle',
        iteration: 0,
        loopMode: strategy.loopMode,
      };
    }

    return {
      statePath: this.getStatePath(),
      exists: true,
      status: state.status,
      goal: state.goal,
      iteration: state.iteration,
      maxIterations: state.maxIterations,
      updatedAt: state.updatedAt,
      lastSummary: state.lastSummary,
      stopReason: state.stopReason,
      stopCategory: state.stopCategory,
      sessionId: state.sessionId,
      autoRunEnabled: state.autoRunEnabled ?? false,
      completionSummary: state.completionSummary,
      loopMode: strategy.loopMode,
    };
  }

  async startLoop(
    goal: string,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    autoRunEnabled = false,
  ) {
    const now = new Date().toISOString();
    const state: LoopRuntimeState = {
      goal: goal.trim(),
      status: 'active',
      iteration: 0,
      createdAt: now,
      updatedAt: now,
      workspaceRoot: this.workspaceRoot,
      sessionId: this.config.getSessionId(),
      maxIterations,
      autoRunEnabled,
      stopCategory: undefined,
    };
    await this.writeState(state);
    return state;
  }

  async beginIteration(
    options: BeginIterationOptions = {},
  ): Promise<{ state: LoopRuntimeState; prompt: string }> {
    const current = await this.requireState();
    const status =
      current.status === 'paused' && options.resume ? 'active' : current.status;

    if (status === 'completed') {
      throw new Error(
        'Loop already completed. Start a new loop before requesting another iteration.',
      );
    }

    if (status !== 'active') {
      throw new Error(
        'Loop is paused. Run /loop resume to continue this long-horizon task.',
      );
    }

    const nextIteration = current.iteration + 1;
    const strategy = await this.automationStrategies.getState();
    const prompt = this.buildIterationPrompt(
      {
        ...current,
        status,
        iteration: nextIteration,
      },
      strategy,
      options.guidance,
    );

    const updated: LoopRuntimeState = {
      ...current,
      status,
      iteration: nextIteration,
      updatedAt: new Date().toISOString(),
      lastPrompt: prompt,
      stopReason: undefined,
      stopCategory: undefined,
    };
    await this.writeState(updated);
    return { state: updated, prompt };
  }

  async pauseLoop(
    reason?: string,
    stopCategory: LoopStopCategory = 'manual',
  ): Promise<LoopRuntimeState> {
    const current = await this.requireState();
    const updated: LoopRuntimeState = {
      ...current,
      status: 'paused',
      updatedAt: new Date().toISOString(),
      stopReason: reason?.trim() || 'Paused by operator.',
      stopCategory,
      autoRunEnabled: false,
    };
    await this.writeState(updated);
    return updated;
  }

  async completeLoop(summary: string): Promise<LoopRuntimeState> {
    const current = await this.requireState();
    const updated: LoopRuntimeState = {
      ...current,
      status: 'completed',
      updatedAt: new Date().toISOString(),
      completionSummary: summary.trim(),
      lastSummary: summary.trim(),
      stopReason: undefined,
      stopCategory: undefined,
      autoRunEnabled: false,
    };
    await this.writeState(updated);
    return updated;
  }

  async recordSummary(summary: string): Promise<LoopRuntimeState> {
    const current = await this.requireState();
    const updated: LoopRuntimeState = {
      ...current,
      updatedAt: new Date().toISOString(),
      lastSummary: summary.trim(),
    };
    await this.writeState(updated);
    return updated;
  }

  async clearLoop(): Promise<void> {
    try {
      await fs.unlink(this.getStatePath());
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async setAutoRunEnabled(enabled: boolean): Promise<LoopRuntimeState> {
    const current = await this.requireState();
    const updated: LoopRuntimeState = {
      ...current,
      updatedAt: new Date().toISOString(),
      autoRunEnabled: enabled,
      stopReason: enabled ? undefined : current.stopReason,
      stopCategory: enabled ? undefined : current.stopCategory,
    };
    await this.writeState(updated);
    return updated;
  }

  async reconcileAssistantResponse(
    responseText: string,
  ): Promise<LoopResponseOutcome> {
    const trimmed = responseText.trim();
    const current = await this.requireState();

    if (!trimmed) {
      const paused = await this.pauseLoop(
        'Auto-run halted because no model output was captured for this iteration.',
        'empty-output',
      );
      return {
        action: 'paused',
        state: paused,
        reason: paused.stopReason,
      };
    }

    const completeMatch = trimmed.match(/^LOOP_COMPLETE:\s*(.+)$/im);
    if (completeMatch) {
      const completed = await this.completeLoop(completeMatch[1].trim());
      return {
        action: 'completed',
        state: completed,
        summary: completed.completionSummary,
      };
    }

    const blockedMatch = trimmed.match(/^LOOP_BLOCKED:\s*(.+)$/im);
    if (blockedMatch) {
      const paused = await this.pauseLoop(blockedMatch[1].trim(), 'blocked');
      return {
        action: 'blocked',
        state: paused,
        reason: paused.stopReason,
      };
    }

    const reviewMatch = trimmed.match(/^LOOP_REVIEW_REQUIRED:\s*(.+)$/im);
    if (reviewMatch) {
      const paused = await this.pauseLoop(
        reviewMatch[1].trim(),
        'review-required',
      );
      return {
        action: 'review',
        state: paused,
        reason: paused.stopReason,
      };
    }

    const delegationMatch = trimmed.match(
      /^AGENT_DELEGATION_REQUIRED:\s*(.+)$/im,
    );
    if (delegationMatch) {
      const paused = await this.pauseLoop(
        delegationMatch[1].trim(),
        'delegation-required',
      );
      return {
        action: 'delegation',
        state: paused,
        reason: paused.stopReason,
      };
    }

    let nextState = current;
    const checkpoint = extractCheckpointSummary(trimmed);
    if (checkpoint) {
      nextState = await this.recordSummary(checkpoint);
    }

    if (nextState.iteration >= nextState.maxIterations) {
      const paused = await this.pauseLoop(
        `Reached the configured loop limit of ${nextState.maxIterations} iterations.`,
        'iteration-limit',
      );
      return {
        action: 'paused',
        state: paused,
        reason: paused.stopReason,
      };
    }

    if (!nextState.autoRunEnabled) {
      return {
        action: 'idle',
        state: nextState,
      };
    }

    return {
      action: 'continue',
      state: nextState,
      summary: checkpoint,
    };
  }

  private async requireState(): Promise<LoopRuntimeState> {
    const state = await this.loadState();
    if (!state) {
      throw new Error(
        'No Gemini-2 loop is active for this project. Run /loop start <goal> first.',
      );
    }
    if (
      state.sessionId !== this.config.getSessionId() ||
      state.workspaceRoot !== this.workspaceRoot
    ) {
      throw new Error(
        'Loop state does not belong to this Gemini-2 session. Start a new loop for the current window.',
      );
    }
    return state;
  }

  private async loadState(): Promise<LoopRuntimeState | null> {
    try {
      const contents = await fs.readFile(this.getStatePath(), 'utf-8');
      return parseLoopRuntimeState(JSON.parse(contents));
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

  private async writeState(state: LoopRuntimeState): Promise<void> {
    await writeJsonFileAtomic(this.getStatePath(), state);
  }

  private buildIterationPrompt(
    state: LoopRuntimeState,
    strategy: AutomationStrategyState,
    guidance?: string,
  ): string {
    const { loopMode, skillsMode, agentsMode } = strategy;
    const modeText =
      loopMode === 'full'
        ? 'full'
        : loopMode === 'auto'
          ? 'auto'
          : 'manual/off';
    const lines = [
      'Gemini-2 Loop Mode is active for a long-horizon task.',
      `Goal: ${state.goal}`,
      `Iteration: ${state.iteration} of up to ${state.maxIterations}`,
      `Workspace root: ${state.workspaceRoot}`,
      `Loop automation strategy: ${modeText}`,
      `Skills automation strategy: ${skillsMode}`,
      `Agent automation strategy: ${agentsMode}`,
      '',
      'Execution contract:',
      '- Respect the shared-fabric governance already injected this turn.',
      '- For complex, parallelizable, or high-risk work, invoke an appropriate subagent instead of doing everything on the main thread.',
      '- Use only the most relevant skills for this iteration, and surface which skills or agents you actually used.',
      '- Prioritize a six-stage workflow: route -> dispatch -> plan -> execute -> review -> report.',
      '- Advance the project by one meaningful iteration, then stop and emit a checkpoint instead of pretending the whole mission is done.',
      '- If you change code, run the most relevant verification step before claiming success.',
      '',
      'Loop strategy semantics:',
      loopMode === 'full'
        ? '- Full mode: continue without waiting for approval on ordinary steps. Only stop if blocked, completed, or a hard safety boundary is reached.'
        : loopMode === 'auto'
          ? '- Auto mode: continue without routine approval, but stop with LOOP_BLOCKED when a destructive, ambiguous, or materially directional decision needs human review.'
          : '- Off/manual mode: keep the iteration scoped and conservative, assuming the operator may advance the loop manually.',
      '',
      'Respond with these sections:',
      '1. Iteration objective',
      '2. Skills and agents used',
      '3. Actions taken',
      '4. Verification / backpressure',
      '5. Checkpoint summary',
      '6. Next step',
      '',
      'If the overall goal is done, begin the response with "LOOP_COMPLETE: <summary>".',
      'If you are blocked, begin the response with "LOOP_BLOCKED: <reason>".',
      'If a meaningful operator decision or audit checkpoint is required before continuing, begin the response with "LOOP_REVIEW_REQUIRED: <reason>".',
      'If explicit subagent delegation is required before this loop should continue, begin the response with "AGENT_DELEGATION_REQUIRED: <reason>".',
    ];

    if (state.lastSummary) {
      lines.push('', `Previous checkpoint: ${state.lastSummary}`);
    }

    if (guidance?.trim()) {
      lines.push(
        '',
        `Operator guidance for this iteration: ${guidance.trim()}`,
      );
    }

    return lines.join('\n');
  }
}

function extractCheckpointSummary(responseText: string): string | undefined {
  const sectionMatch = responseText.match(
    /(?:^|\n)5\.\s*Checkpoint summary\s*\n([\s\S]*?)(?=\n6\.\s*Next step|\n*$)/i,
  );
  const candidate = sectionMatch?.[1]?.trim();
  if (candidate) {
    return candidate.replace(/\n{2,}/g, '\n').trim();
  }

  const inlineMatch = responseText.match(/Checkpoint summary\s*:\s*(.+)$/im);
  return inlineMatch?.[1]?.trim();
}
