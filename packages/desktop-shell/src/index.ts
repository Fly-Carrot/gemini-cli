/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { GeminiCliAgent, type GeminiCliSession } from '@google/gemini-cli-sdk';
import { GeminiEventType } from '@google/gemini-cli-core';
import { INDEX_HTML, CLIENT_JS } from './_client-assets.js';

type ModelChoice = 'auto' | 'flash' | 'pro';
type EffortChoice = 'low' | 'medium' | 'high';
type LoopStatus = 'idle' | 'active' | 'paused' | 'completed';

interface StudioMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: string;
  pending?: boolean;
}

interface ActivityItem {
  id: string;
  kind: 'status' | 'tool' | 'skill' | 'agent' | 'loop';
  title: string;
  detail?: string;
  timestamp: string;
  tone?: 'default' | 'success' | 'warning';
}

interface StudioState {
  sessionId: string | null;
  workspaceRoot: string;
  fabricRoot: string;
  controls: {
    model: ModelChoice;
    effort: EffortChoice;
  };
  runtime: {
    busy: boolean;
    turnCount: number;
    activeSkills: string[];
    activeAgents: string[];
    recentTools: string[];
    lastUpdatedAt: string | null;
  };
  loop: {
    status: LoopStatus;
    goal: string;
    iteration: number;
    maxIterations: number;
    autoRun: boolean;
    lastCheckpoint: string;
    stopReason: string;
  };
  messages: StudioMessage[];
  activity: ActivityItem[];
}

type ClientCommand =
  | { type: 'get_state' }
  | { type: 'submit_prompt'; prompt: string }
  | { type: 'set_model'; model: ModelChoice }
  | { type: 'set_effort'; effort: EffortChoice }
  | { type: 'loop_start'; goal: string; maxIterations?: number }
  | { type: 'loop_run'; goal?: string; maxIterations?: number }
  | { type: 'loop_stop' };

const DEFAULT_PORT = Number(process.env['GEMINI2_STUDIO_PORT'] || 43137);

function getDefaultSharedFabricRoot(): string {
  return path.join(os.homedir(), 'Antigravity_Skills', 'global-agent-fabric');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readStringProperty(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function readNumberProperty(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const candidate = value[key];
  return typeof candidate === 'number' ? candidate : undefined;
}

function isModelChoice(value: unknown): value is ModelChoice {
  return value === 'auto' || value === 'flash' || value === 'pro';
}

function isEffortChoice(value: unknown): value is EffortChoice {
  return value === 'low' || value === 'medium' || value === 'high';
}

function getDefaultModelChoice(): ModelChoice {
  const candidate = process.env['GEMINI2_DEFAULT_MODEL'];
  return isModelChoice(candidate) ? candidate : 'pro';
}

function getDefaultEffortChoice(): EffortChoice {
  const candidate = process.env['GEMINI2_DEFAULT_EFFORT'];
  return isEffortChoice(candidate) ? candidate : 'high';
}

export function parseClientCommand(value: unknown): ClientCommand | null {
  if (!isRecord(value)) {
    return null;
  }

  const type = readStringProperty(value, 'type');
  if (!type) {
    return null;
  }

  switch (type) {
    case 'get_state':
    case 'loop_stop':
      return { type };
    case 'submit_prompt': {
      const prompt = readStringProperty(value, 'prompt');
      return prompt ? { type: 'submit_prompt', prompt } : null;
    }
    case 'set_model': {
      const model = value['model'];
      return isModelChoice(model) ? { type: 'set_model', model } : null;
    }
    case 'set_effort': {
      const effort = value['effort'];
      return isEffortChoice(effort) ? { type: 'set_effort', effort } : null;
    }
    case 'loop_start': {
      const goal = readStringProperty(value, 'goal');
      if (!goal) {
        return null;
      }
      return {
        type: 'loop_start',
        goal,
        maxIterations: readNumberProperty(value, 'maxIterations'),
      };
    }
    case 'loop_run': {
      const goal = readStringProperty(value, 'goal');
      return {
        type: 'loop_run',
        goal,
        maxIterations: readNumberProperty(value, 'maxIterations'),
      };
    }
    default:
      return null;
  }
}

export class GeminiDesktopShell {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly sockets = new Set<WebSocket>();
  private agent: GeminiCliAgent | null = null;
  private session: GeminiCliSession | null = null;
  private autoRunTimer: NodeJS.Timeout | null = null;

  private readonly state: StudioState = {
    sessionId: null,
    workspaceRoot:
      process.env['GEMINI2_SHARED_FABRIC_WORKSPACE'] ||
      process.env['AGF_WORKSPACE'] ||
      process.cwd(),
    fabricRoot:
      process.env['GEMINI2_SHARED_FABRIC_ROOT'] ||
      process.env['AGF_GLOBAL_ROOT'] ||
      getDefaultSharedFabricRoot(),
    controls: {
      model: getDefaultModelChoice(),
      effort: getDefaultEffortChoice(),
    },
    runtime: {
      busy: false,
      turnCount: 0,
      activeSkills: [],
      activeAgents: [],
      recentTools: [],
      lastUpdatedAt: null,
    },
    loop: {
      status: 'idle',
      goal: '',
      iteration: 0,
      maxIterations: 8,
      autoRun: false,
      lastCheckpoint: '',
      stopReason: '',
    },
    messages: [
      {
        id: randomUUID(),
        role: 'system',
        text: 'Gemini-2 Studio is ready. Use the composer for a normal prompt, or type a long-horizon goal and hit Run Loop.',
        timestamp: new Date().toISOString(),
      },
    ],
    activity: [],
  };

  constructor(private readonly port = DEFAULT_PORT) {
    if (
      !process.env['GOOGLE_GENAI_USE_GCA'] &&
      !process.env['GEMINI_API_KEY'] &&
      !process.env['GOOGLE_GENAI_USE_VERTEXAI']
    ) {
      process.env['GOOGLE_GENAI_USE_GCA'] = 'true';
    }
  }

  async start(): Promise<string> {
    if (this.server) {
      return this.url();
    }

    this.server = http.createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(INDEX_HTML);
        return;
      }
      if (req.url === '/assets/main.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(CLIENT_JS);
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });

    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });
    this.wss.on('error', (error) => {
      this.emitToast(
        `Desktop shell websocket failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'warning',
      );
    });
    this.wss.on('connection', (ws, req) => {
      if (!isAllowedDesktopShellOrigin(req.headers.origin, this.port)) {
        ws.close(1008, 'Origin not allowed');
        return;
      }

      this.sockets.add(ws);
      ws.send(JSON.stringify({ type: 'state', payload: this.state }));

      ws.on('message', async (buffer) => {
        try {
          const command = parseClientCommand(JSON.parse(String(buffer)));
          if (!command) {
            throw new Error(
              'Received an invalid desktop-shell command payload.',
            );
          }
          await this.handleClientCommand(command);
        } catch (error) {
          this.emitToast(
            `Desktop shell command failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            'warning',
          );
        }
      });

      ws.on('close', () => {
        this.sockets.delete(ws);
      });
    });

    await new Promise<void>((resolve, reject) => {
      const handleError = (error: Error) => {
        this.server?.off('error', handleError);
        reject(error);
      };
      this.server!.on('error', handleError);
      this.server!.listen(this.port, '127.0.0.1', () => {
        this.server?.off('error', handleError);
        resolve();
      });
    });

    this.recordActivity(
      'status',
      'Studio booted',
      `Listening at ${this.url()}`,
      'success',
    );
    this.broadcastState();
    return this.url();
  }

  private url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private broadcastState() {
    const payload = JSON.stringify({ type: 'state', payload: this.state });
    for (const socket of this.sockets) {
      socket.send(payload);
    }
  }

  private emitToast(message: string, tone: 'default' | 'success' | 'warning') {
    const payload = JSON.stringify({
      type: 'toast',
      payload: { message, tone },
    });
    for (const socket of this.sockets) {
      socket.send(payload);
    }
  }

  private recordActivity(
    kind: ActivityItem['kind'],
    title: string,
    detail?: string,
    tone: ActivityItem['tone'] = 'default',
  ) {
    this.state.activity.unshift({
      id: randomUUID(),
      kind,
      title,
      detail,
      tone,
      timestamp: new Date().toISOString(),
    });
    this.state.activity = this.state.activity.slice(0, 40);
    this.state.runtime.lastUpdatedAt = new Date().toISOString();
  }

  private async handleClientCommand(command: ClientCommand): Promise<void> {
    switch (command.type) {
      case 'get_state':
        this.broadcastState();
        return;
      case 'set_model':
        this.state.controls.model = command.model;
        this.resetRuntimeSession(
          `Model switched to ${command.model}. A fresh session will be created on the next turn.`,
        );
        return;
      case 'set_effort':
        this.state.controls.effort = command.effort;
        this.resetRuntimeSession(
          `Effort preset switched to ${command.effort}. Future turns will use the new prompt profile.`,
        );
        return;
      case 'submit_prompt':
        await this.runPrompt(command.prompt);
        return;
      case 'loop_start':
        this.startLoop(command.goal, command.maxIterations ?? 8, false);
        await this.runLoopIteration();
        return;
      case 'loop_run':
        if (command.goal?.trim()) {
          this.startLoop(command.goal, command.maxIterations ?? 8, true);
        } else {
          if (!this.state.loop.goal) {
            this.emitToast(
              'Type a loop goal before starting autorun.',
              'warning',
            );
            return;
          }
          this.state.loop.autoRun = true;
          this.state.loop.status = 'active';
        }
        this.recordActivity(
          'loop',
          'Autorun enabled',
          `${this.state.loop.goal} · ${this.state.loop.iteration}/${this.state.loop.maxIterations}`,
          'success',
        );
        this.broadcastState();
        await this.runLoopIteration();
        return;
      case 'loop_stop':
        this.stopLoop('Stopped by operator.');
        return;
      default:
        return;
    }
  }

  private resetRuntimeSession(detail: string) {
    this.agent = null;
    this.session = null;
    this.state.sessionId = null;
    this.recordActivity('status', 'Runtime reset', detail);
    this.broadcastState();
  }

  private createAgent(): GeminiCliAgent {
    return new GeminiCliAgent({
      cwd: this.state.workspaceRoot,
      model: mapModelChoice(this.state.controls.model),
      instructions: buildSystemInstructions(this.state.controls.effort),
    });
  }

  private async ensureSession(): Promise<GeminiCliSession> {
    if (!this.agent) {
      this.agent = this.createAgent();
    }
    if (!this.session) {
      this.session = this.agent.session();
      this.state.sessionId = this.session.id;
      this.recordActivity(
        'status',
        'Session opened',
        this.session.id,
        'success',
      );
    }
    return this.session;
  }

  private async runPrompt(prompt: string): Promise<void> {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || this.state.runtime.busy) {
      return;
    }

    const session = await this.ensureSession();
    const userMessage: StudioMessage = {
      id: randomUUID(),
      role: 'user',
      text: cleanPrompt,
      timestamp: new Date().toISOString(),
    };
    const assistantMessage: StudioMessage = {
      id: randomUUID(),
      role: 'assistant',
      text: '',
      timestamp: new Date().toISOString(),
      pending: true,
    };

    this.state.messages.push(userMessage, assistantMessage);
    this.state.runtime.busy = true;
    this.state.runtime.turnCount += 1;
    this.broadcastState();

    try {
      for await (const event of session.sendStream(cleanPrompt)) {
        if (event.type === GeminiEventType.Content) {
          assistantMessage.text += String(event.value ?? '');
          this.broadcastState();
        }

        if (event.type === GeminiEventType.ToolCallRequest) {
          const name = event.value.name;
          this.recordToolUsage(name, event.value.args);
          this.broadcastState();
        }
      }

      assistantMessage.pending = false;
      if (!assistantMessage.text.trim()) {
        assistantMessage.text =
          'No visible assistant text was returned for this turn.';
      }

      this.state.runtime.busy = false;
      this.broadcastState();
      await this.maybeContinueLoop(assistantMessage.text);
    } catch (error) {
      assistantMessage.pending = false;
      assistantMessage.text =
        error instanceof Error ? error.message : String(error);
      this.state.runtime.busy = false;
      this.recordActivity(
        'status',
        'Turn failed',
        assistantMessage.text,
        'warning',
      );
      this.broadcastState();
    }
  }

  private recordToolUsage(rawName: string, args: unknown) {
    const name = rawName || 'unknown-tool';
    this.state.runtime.recentTools = uniqueHead(
      [name, ...this.state.runtime.recentTools],
      8,
    );
    this.recordActivity('tool', name, stringifyArgs(args));

    if (name === 'activate_skill') {
      const skill = readArg(args, 'skill_name') || readArg(args, 'name');
      if (skill) {
        this.state.runtime.activeSkills = uniqueHead(
          [skill, ...this.state.runtime.activeSkills],
          8,
        );
        this.recordActivity('skill', `Activated ${skill}`);
      }
    }

    if (name === 'invoke_agent') {
      const agent =
        readArg(args, 'agent_name') ||
        readArg(args, 'agent') ||
        readArg(args, 'name');
      if (agent) {
        this.state.runtime.activeAgents = uniqueHead(
          [agent, ...this.state.runtime.activeAgents],
          8,
        );
        this.recordActivity('agent', `Invoked ${agent}`);
      }
    }
  }

  private startLoop(goal: string, maxIterations: number, autoRun: boolean) {
    this.clearAutoRunTimer();
    this.state.loop = {
      status: 'active',
      goal: goal.trim(),
      iteration: 0,
      maxIterations,
      autoRun,
      lastCheckpoint: '',
      stopReason: '',
    };
    this.recordActivity(
      'loop',
      autoRun ? 'Loop autorun started' : 'Loop started',
      `${goal.trim()} · max ${maxIterations}`,
      'success',
    );
    this.broadcastState();
  }

  private stopLoop(reason: string) {
    this.clearAutoRunTimer();
    this.state.loop.status = 'paused';
    this.state.loop.autoRun = false;
    this.state.loop.stopReason = reason;
    this.recordActivity('loop', 'Loop stopped', reason, 'warning');
    this.broadcastState();
  }

  private async runLoopIteration(): Promise<void> {
    if (!this.state.loop.goal || this.state.runtime.busy) {
      return;
    }

    this.state.loop.status = 'active';
    this.state.loop.iteration += 1;
    const prompt = buildLoopPrompt(this.state.loop);
    await this.runPrompt(prompt);
  }

  private async maybeContinueLoop(responseText: string): Promise<void> {
    if (this.state.loop.status === 'idle') {
      return;
    }

    const trimmed = responseText.trim();
    if (!trimmed) {
      this.stopLoop(
        'Loop paused because the last iteration produced no visible output.',
      );
      return;
    }

    const completeMatch = trimmed.match(/^LOOP_COMPLETE:\s*(.+)$/im);
    if (completeMatch) {
      this.clearAutoRunTimer();
      this.state.loop.status = 'completed';
      this.state.loop.autoRun = false;
      this.state.loop.lastCheckpoint = completeMatch[1].trim();
      this.recordActivity(
        'loop',
        'Loop completed',
        completeMatch[1].trim(),
        'success',
      );
      this.broadcastState();
      return;
    }

    const blockedMatch = trimmed.match(/^LOOP_BLOCKED:\s*(.+)$/im);
    if (blockedMatch) {
      this.stopLoop(blockedMatch[1].trim());
      return;
    }

    const checkpoint = extractCheckpoint(trimmed);
    if (checkpoint) {
      this.state.loop.lastCheckpoint = checkpoint;
    }

    if (this.state.loop.iteration >= this.state.loop.maxIterations) {
      this.stopLoop(
        `Reached the configured loop limit of ${this.state.loop.maxIterations} iterations.`,
      );
      return;
    }

    if (!this.state.loop.autoRun) {
      this.broadcastState();
      return;
    }

    this.recordActivity(
      'loop',
      `Auto-running loop iteration ${this.state.loop.iteration + 1}/${this.state.loop.maxIterations}`,
      checkpoint ||
        'Previous iteration finished cleanly; queuing the next one.',
      'success',
    );
    this.broadcastState();

    this.clearAutoRunTimer();
    this.autoRunTimer = setTimeout(() => {
      void this.runLoopIteration();
    }, 350);
  }

  private clearAutoRunTimer() {
    if (this.autoRunTimer) {
      clearTimeout(this.autoRunTimer);
      this.autoRunTimer = null;
    }
  }
}

function uniqueHead(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

function readArg(args: unknown, key: string): string | undefined {
  if (!isRecord(args) || !(key in args)) {
    return undefined;
  }
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function stringifyArgs(args: unknown): string | undefined {
  if (!args) return undefined;
  try {
    return JSON.stringify(args);
  } catch {
    return undefined;
  }
}

function mapModelChoice(choice: ModelChoice): string {
  if (choice === 'flash') return 'flash';
  if (choice === 'auto') return 'auto';
  return 'pro';
}

function buildSystemInstructions(effort: EffortChoice): string {
  const effortGuidance =
    effort === 'low'
      ? 'Bias toward speed. Keep answers concise and avoid over-planning unless the task clearly demands it.'
      : effort === 'medium'
        ? 'Balance speed and depth. Plan enough to be reliable, but stay pragmatic.'
        : 'Use high reasoning effort. Think carefully, verify claims when possible, and expose a clear engineering path.';

  return [
    'You are Gemini-2 Studio, a chat-first interface for a powerful coding runtime.',
    effortGuidance,
    'If the user appears to be pursuing a multi-step engineering goal, prefer explicit checkpoints and progress summaries.',
    'When skills or subagents would materially help, call the relevant tools and explain what you activated.',
  ].join(' ');
}

function buildLoopPrompt(loop: StudioState['loop']): string {
  const lines = [
    'Gemini-2 Loop Mode is active for a long-horizon task.',
    `Goal: ${loop.goal}`,
    `Iteration: ${loop.iteration} of up to ${loop.maxIterations}`,
    '',
    'Execution contract:',
    '- Advance the project by one meaningful iteration.',
    '- Prefer the most relevant skills or agents when they materially improve quality.',
    '- Validate your work before claiming progress.',
    '- End with a checkpoint summary and a next step.',
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
  ];

  if (loop.lastCheckpoint) {
    lines.push('', `Previous checkpoint: ${loop.lastCheckpoint}`);
  }

  return lines.join('\n');
}

export function isAllowedDesktopShellOrigin(
  origin: string | undefined,
  port: number,
): boolean {
  if (!origin) {
    return true;
  }

  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
      parsed.port === String(port)
    );
  } catch {
    return false;
  }
}

function extractCheckpoint(responseText: string): string | undefined {
  const sectionMatch = responseText.match(
    /(?:^|\n)5\.\s*Checkpoint summary\s*\n([\s\S]*?)(?=\n6\.\s*Next step|\n*$)/i,
  );
  return sectionMatch?.[1]?.trim();
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const shell = new GeminiDesktopShell();
  shell
    .start()
    .then((url) => {
      // eslint-disable-next-line no-console
      console.log(`Gemini-2 Studio running at ${url}`);
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error);
      process.exitCode = 1;
    });
}
