/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ACTIVATE_SKILL_TOOL_NAME,
  ActivateSkillTool,
  convertToFunctionResponse,
  type Config,
  type GeminiClient,
} from '@google/gemini-cli-core';
import {
  SharedFabricRegistry,
  type SharedFabricSkillCandidate,
} from './sharedFabricRegistry.js';

const DEFAULT_MAX_AUTO_SKILLS = 1;
const MIN_QUERY_LENGTH_FOR_ROUTING = 8;
const SKILL_AUTO_ACTIVATION_SCORE = 7;
const AGENT_HINT_SCORE = 6;
const AMBIGUITY_SCORE_DELTA = 2;
const GLOBAL_PROFILE_MAX_CHARS = 1400;
const WORKSPACE_PROFILE_MAX_CHARS = 1400;
const TRUNCATION_SUFFIX = '\n...[truncated]';

export interface SharedFabricAutoActivatedSkill {
  name: string;
  sourcePath: string;
  loadedIntoSession: boolean;
}

export interface SharedFabricAgentHint {
  name: string;
  displayName?: string;
  description?: string;
  score: number;
}

export interface SharedFabricAutoRouteNotice {
  text: string;
  secondaryText?: string;
}

export interface SharedFabricAutoRouteResult {
  queryToSend: string;
  notices: SharedFabricAutoRouteNotice[];
  activatedSkills: SharedFabricAutoActivatedSkill[];
  agentHint?: SharedFabricAgentHint;
}

interface ContextBundle {
  block: string;
  seededSessionContext: boolean;
  globalProfileLoaded: boolean;
  workspaceProfileLoaded: boolean;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(/[^a-z0-9\u4e00-\u9fff-]+/i)
    .filter(Boolean);
}

function truncateText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars - TRUNCATION_SUFFIX.length).trimEnd()}${TRUNCATION_SUFFIX}`;
}

function stripManagedHeader(content: string): string {
  return content.replace(/^<!--[\s\S]*?-->\s*/u, '').trim();
}

function formatProfileExcerpt(content: string, maxChars: number): string {
  return truncateText(stripManagedHeader(content), maxChars);
}

export class SharedFabricAutoRouter {
  private readonly registry: SharedFabricRegistry;
  private sharedContextSeeded = false;
  private cachedRuntimeOrder?: string[];
  private cachedGlobalProfile?: string | null;

  constructor(
    private readonly config: Config,
    private readonly geminiClient: Pick<GeminiClient, 'addHistory'>,
  ) {
    this.registry = new SharedFabricRegistry({
      workspaceRoot: config.getWorkingDir(),
    });
  }

  async preparePrompt(
    query: string,
    abortSignal: AbortSignal,
  ): Promise<SharedFabricAutoRouteResult> {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
      return {
        queryToSend: trimmedQuery,
        notices: [],
        activatedSkills: [],
      };
    }

    const notices: SharedFabricAutoRouteNotice[] = [];
    const contextBundle = await this.buildContextBundle();
    if (contextBundle.seededSessionContext) {
      notices.push({
        text: 'Loaded shared-fabric session context.',
        secondaryText:
          'Global question profile, runtime bootstrap order, and workspace overlay are now part of this Gemini-2 session.',
      });
    }

    let activatedSkills: SharedFabricAutoActivatedSkill[] = [];
    let agentHint: SharedFabricAgentHint | undefined;
    let matchedDomainLabel: string | undefined;

    if (trimmedQuery.length >= MIN_QUERY_LENGTH_FOR_ROUTING) {
      const route = await this.registry.recommendSkills(trimmedQuery, 4);
      matchedDomainLabel = route.domain?.label;
      activatedSkills = await this.autoActivateSkills(
        route.skills,
        abortSignal,
      );
      if (activatedSkills.length > 0) {
        notices.push({
          text: `Auto-loaded ${activatedSkills.length} shared-fabric skill${activatedSkills.length > 1 ? 's' : ''}.`,
          secondaryText: activatedSkills
            .map((skill) => `${skill.name} (${skill.sourcePath})`)
            .join(' | '),
        });
      }

      agentHint = this.pickAgentHint(trimmedQuery);
      if (agentHint) {
        notices.push({
          text: `Auto-routed agent hint: ${agentHint.name}.`,
          secondaryText:
            'If delegation is useful, the model should prefer the explicit invoke_agent tool rather than hidden role-play.',
        });
      }
    }

    const routingBlock = this.buildRoutingBlock({
      matchedDomainLabel,
      activatedSkills,
      agentHint,
    });
    const querySections = [
      contextBundle.block,
      routingBlock,
      `<user_request>\n${trimmedQuery}\n</user_request>`,
    ].filter((section) => section.trim().length > 0);

    return {
      queryToSend: querySections.join('\n\n'),
      notices,
      activatedSkills,
      agentHint,
    };
  }

  private async buildContextBundle(): Promise<ContextBundle> {
    const runtimeOrder = await this.loadRuntimeBootstrapOrder();
    const globalProfile = await this.loadGlobalProfile();
    const workspaceOverlay = await this.loadWorkspaceOverlay();
    const seededSessionContext = !this.sharedContextSeeded;
    const sections: string[] = [];

    if (seededSessionContext) {
      const globalLines = [
        `Canonical root: ${this.registry.globalRoot}`,
        'Boot contract: preflight_check.py -> sync_all.py -> workspace overlay -> [BOOT_OK].',
        'Memory routing: stable reusable learnings -> promoted learning; trial-and-error / detailed process notes -> MemPalace.',
      ];
      if (globalProfile) {
        globalLines.push(
          'Global user-question profile excerpt:',
          formatProfileExcerpt(globalProfile, GLOBAL_PROFILE_MAX_CHARS),
        );
      }
      sections.push(
        `<global_shared_context source="${path.join(
          this.registry.globalRoot,
          'memory',
          'user-question-profile.md',
        )}">\n${globalLines.join('\n')}\n</global_shared_context>`,
      );

      const runtimeLines = [
        'Runtime identity: gemini-2 (Gemini CLI fork with shared-fabric integration).',
        'Preferred bootstrap order:',
        ...runtimeOrder.map((entry, index) => `${index + 1}. ${entry}`),
      ];
      sections.push(
        `<runtime_specific_context source="${this.registry.runtimeMapPath}">\n${runtimeLines.join(
          '\n',
        )}\n</runtime_specific_context>`,
      );
    }

    if (workspaceOverlay) {
      sections.push(
        `<project_overlay source="${this.registry.workspaceOverlayPath}">\n${formatProfileExcerpt(
          workspaceOverlay,
          WORKSPACE_PROFILE_MAX_CHARS,
        )}\n</project_overlay>`,
      );
    }

    if (sections.length === 0) {
      return {
        block: '',
        seededSessionContext: false,
        globalProfileLoaded: false,
        workspaceProfileLoaded: false,
      };
    }

    this.sharedContextSeeded = true;
    return {
      block: `<shared_fabric_context>\n${sections.join('\n\n')}\n</shared_fabric_context>`,
      seededSessionContext,
      globalProfileLoaded: !!globalProfile,
      workspaceProfileLoaded: !!workspaceOverlay,
    };
  }

  private buildRoutingBlock(options: {
    matchedDomainLabel?: string;
    activatedSkills: SharedFabricAutoActivatedSkill[];
    agentHint?: SharedFabricAgentHint;
  }): string {
    const lines: string[] = [];

    if (options.matchedDomainLabel) {
      lines.push(`Matched shared-fabric domain: ${options.matchedDomainLabel}`);
    }
    if (options.activatedSkills.length > 0) {
      lines.push(
        `Auto-activated shared-fabric skills: ${options.activatedSkills
          .map((skill) => skill.name)
          .join(', ')}`,
      );
    }
    if (options.agentHint) {
      lines.push(
        `Preferred agent candidate: ${options.agentHint.name}${
          options.agentHint.displayName
            ? ` (${options.agentHint.displayName})`
            : ''
        }`,
      );
      lines.push(
        'Use the explicit invoke_agent tool if delegation becomes useful; do not silently simulate a subagent.',
      );
    }

    if (lines.length === 0) {
      return '';
    }

    return `<shared_fabric_routing>\n${lines.join('\n')}\n</shared_fabric_routing>`;
  }

  private async autoActivateSkills(
    candidates: SharedFabricSkillCandidate[],
    abortSignal: AbortSignal,
  ): Promise<SharedFabricAutoActivatedSkill[]> {
    const selected = this.pickSkillsForAutoActivation(candidates);
    const activations: SharedFabricAutoActivatedSkill[] = [];

    for (const candidate of selected) {
      const activation = await this.activateSkill(candidate, abortSignal);
      if (activation) {
        activations.push(activation);
      }
    }

    return activations;
  }

  private pickSkillsForAutoActivation(
    candidates: SharedFabricSkillCandidate[],
  ): SharedFabricSkillCandidate[] {
    if (candidates.length === 0) {
      return [];
    }

    const [topCandidate, secondCandidate] = candidates;
    const topScore = topCandidate.score ?? 0;
    const secondScore = secondCandidate?.score ?? 0;
    const isAmbiguous =
      secondCandidate &&
      topScore > 0 &&
      topScore - secondScore < AMBIGUITY_SCORE_DELTA;
    const isHighRisk = normalize(topCandidate.risk || '') === 'high';

    if (topScore < SKILL_AUTO_ACTIVATION_SCORE || isAmbiguous || isHighRisk) {
      return [];
    }

    return candidates.slice(0, DEFAULT_MAX_AUTO_SKILLS);
  }

  private async activateSkill(
    candidate: SharedFabricSkillCandidate,
    abortSignal: AbortSignal,
  ): Promise<SharedFabricAutoActivatedSkill | null> {
    const skillManager = this.config.getSkillManager();
    let skill = skillManager.getSkill(candidate.name);
    let loadedIntoSession = false;

    if (!skill) {
      const loadedSkill = await this.registry.loadSkillDefinition(
        candidate.name,
      );
      if (!loadedSkill) {
        return null;
      }
      skillManager.addSkills([loadedSkill]);
      skill = loadedSkill;
      loadedIntoSession = true;
    }

    if (skillManager.isSkillActive(skill.name)) {
      return null;
    }

    const tool = new ActivateSkillTool(
      this.config,
      this.config.getMessageBus(),
    );
    const callId = `auto-skill-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const invocation = tool.build({ name: skill.name });
    const result = await invocation.execute({ abortSignal });

    await this.geminiClient.addHistory({
      role: 'model',
      parts: [
        {
          functionCall: {
            name: ACTIVATE_SKILL_TOOL_NAME,
            args: { name: skill.name },
          },
        },
      ],
    });
    await this.geminiClient.addHistory({
      role: 'user',
      parts: convertToFunctionResponse(
        ACTIVATE_SKILL_TOOL_NAME,
        callId,
        result.llmContent,
        this.config.getModel(),
        this.config,
      ),
    });

    return {
      name: skill.name,
      sourcePath: skill.location,
      loadedIntoSession,
    };
  }

  private pickAgentHint(query: string): SharedFabricAgentHint | undefined {
    const agentRegistry = this.config.getAgentRegistry();
    if (!agentRegistry) {
      return undefined;
    }

    const queryTokens = tokenize(query);
    const queryNormalized = normalize(query);
    const ranked = agentRegistry
      .getAllDefinitions()
      .map((definition) => {
        const name = normalize(definition.name);
        const displayName = normalize(definition.displayName || '');
        const description = normalize(definition.description || '');
        let score = 0;

        if (name === queryNormalized || displayName === queryNormalized) {
          score += 10;
        }

        for (const token of queryTokens) {
          if (name.includes(token)) score += 4;
          if (displayName.includes(token)) score += 3;
          if (description.includes(token)) score += 2;
        }

        return {
          name: definition.name,
          displayName: definition.displayName,
          description: definition.description,
          score,
        } satisfies SharedFabricAgentHint;
      })
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score);

    const [topCandidate, secondCandidate] = ranked;
    if (!topCandidate) {
      return undefined;
    }

    const ambiguous =
      secondCandidate &&
      topCandidate.score - secondCandidate.score < AMBIGUITY_SCORE_DELTA;
    if (topCandidate.score < AGENT_HINT_SCORE || ambiguous) {
      return undefined;
    }

    return topCandidate;
  }

  private async loadRuntimeBootstrapOrder(): Promise<string[]> {
    if (this.cachedRuntimeOrder) {
      return this.cachedRuntimeOrder;
    }

    const content = await fs
      .readFile(this.registry.runtimeMapPath, 'utf-8')
      .catch(() => '');
    if (!content) {
      this.cachedRuntimeOrder = [
        path.join(
          this.registry.globalRoot,
          'rules',
          'global',
          'gemini-global.md',
        ),
        path.join(this.registry.globalRoot, 'projects', 'registry.yaml'),
        path.join(this.registry.globalRoot, 'mcp', 'servers.yaml'),
        path.join(this.registry.globalRoot, 'skills', 'sources.yaml'),
      ];
      return this.cachedRuntimeOrder;
    }

    const lines = content.split(/\r?\n/);
    const runtimeOrder: string[] = [];
    let inCodex = false;
    let inPreferredOrder = false;

    for (const line of lines) {
      if (/^\s*codex:\s*$/.test(line)) {
        inCodex = true;
        continue;
      }
      if (
        inCodex &&
        /^\s*[a-zA-Z0-9_-]+:\s*$/.test(line) &&
        !/preferred_bootstrap_order/.test(line)
      ) {
        inCodex = false;
        inPreferredOrder = false;
      }
      if (!inCodex) {
        continue;
      }
      if (/^\s*preferred_bootstrap_order:\s*$/.test(line)) {
        inPreferredOrder = true;
        continue;
      }
      if (inPreferredOrder) {
        const match = line.match(/^\s*-\s+"?(.+?)"?\s*$/);
        if (match) {
          runtimeOrder.push(match[1]);
          continue;
        }
        if (line.trim().length > 0 && !line.startsWith('      ')) {
          break;
        }
      }
    }

    this.cachedRuntimeOrder =
      runtimeOrder.length > 0
        ? runtimeOrder
        : [
            path.join(
              this.registry.globalRoot,
              'rules',
              'global',
              'gemini-global.md',
            ),
            path.join(this.registry.globalRoot, 'projects', 'registry.yaml'),
            path.join(this.registry.globalRoot, 'mcp', 'servers.yaml'),
            path.join(this.registry.globalRoot, 'skills', 'sources.yaml'),
          ];
    return this.cachedRuntimeOrder;
  }

  private async loadGlobalProfile(): Promise<string | null> {
    if (this.cachedGlobalProfile !== undefined) {
      return this.cachedGlobalProfile;
    }

    const globalProfilePath = path.join(
      this.registry.globalRoot,
      'memory',
      'user-question-profile.md',
    );
    const content = await fs
      .readFile(globalProfilePath, 'utf-8')
      .catch(() => '');
    this.cachedGlobalProfile = content || null;
    return this.cachedGlobalProfile;
  }

  private async loadWorkspaceOverlay(): Promise<string | null> {
    const content = await fs
      .readFile(this.registry.workspaceOverlayPath, 'utf-8')
      .catch(() => '');
    return content || null;
  }
}
