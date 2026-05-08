/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  tokenLimit,
  type Config,
  type MemoryContextManager,
} from '@google/gemini-cli-core';
import type { SessionStatsState } from '../ui/contexts/SessionContext.js';
import { AutomationStrategyService } from './automationStrategyService.js';
import {
  LoopRuntimeService,
  type LoopRuntimeSnapshot,
} from './loopRuntimeService.js';
import { SharedFabricRegistry } from './sharedFabricRegistry.js';

export interface QueryRuntimeSnapshot {
  sessionId: string;
  model: string;
  promptCount: number;
  lastPromptTokenCount: number;
  tokenLimit: number;
  contextUsagePercent: number;
  compressionThreshold?: number;
  compressionThresholdTokenCount?: number;
  compressionThresholdUsagePercent?: number;
  activeSkillNames: string[];
  discoveredAgentNames: string[];
  memory: {
    jitEnabled: boolean;
    loadedPathCount: number;
    loadedPaths: string[];
    globalChars: number;
    extensionChars: number;
    projectChars: number;
    userProjectChars: number;
  };
  checkpoints: {
    enabled: boolean;
    directory: string;
    count: number;
  };
  sharedFabric: {
    available: boolean;
    indexedSkillCount: number;
    routedDomainCount: number;
    workspaceOverlayPath: string;
    workspaceOverlayExists: boolean;
    workspaceRoot: string;
    globalRoot: string;
  };
  loop: LoopRuntimeSnapshot;
  automation: {
    loopMode: 'off' | 'auto' | 'full';
    skillsMode: 'manual' | 'auto' | 'full';
    agentsMode: 'manual' | 'auto' | 'full';
    shellReplyMode: 'manual' | 'suggest' | 'auto';
  };
  bridge: {
    snapshotPath: string;
    updatedAt: string;
  };
}

interface QueryRuntimeServiceOptions {
  workspaceRoot?: string;
}

function percent(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return Math.round((numerator / denominator) * 1000) / 10;
}

function getMemoryManager(config: Config): MemoryContextManager | undefined {
  return config.getMemoryContextManager();
}

export class QueryRuntimeService {
  private readonly sharedFabricRegistry: SharedFabricRegistry;
  private readonly loopRuntimeService: LoopRuntimeService;

  constructor(
    private readonly config: Config,
    private readonly sessionStats: SessionStatsState,
    options: QueryRuntimeServiceOptions = {},
  ) {
    this.sharedFabricRegistry = new SharedFabricRegistry({
      workspaceRoot: options.workspaceRoot || config.getWorkingDir(),
    });
    this.loopRuntimeService = new LoopRuntimeService(
      config,
      options.workspaceRoot || config.getWorkingDir(),
    );
  }

  async collectStatus(): Promise<QueryRuntimeSnapshot> {
    const model = this.config.getModel();
    const limit = tokenLimit(model);
    const lastPromptTokenCount = this.sessionStats.lastPromptTokenCount ?? 0;
    const compressionThreshold = await this.config.getCompressionThreshold();
    const compressionThresholdTokenCount =
      compressionThreshold !== undefined
        ? Math.round(limit * compressionThreshold)
        : undefined;
    const compressionThresholdUsagePercent =
      compressionThresholdTokenCount !== undefined
        ? percent(lastPromptTokenCount, compressionThresholdTokenCount)
        : undefined;

    const skillManager = this.config.getSkillManager();
    const activeSkillNames = skillManager
      ? skillManager
          .getAllSkills()
          .filter((skill) => skillManager.isSkillActive(skill.name))
          .map((skill) => skill.name)
      : [];

    const agentRegistry = this.config.getAgentRegistry();
    const discoveredAgentNames = agentRegistry
      ? agentRegistry.getAllDefinitions().map((definition) => definition.name)
      : [];

    const memoryManager = getMemoryManager(this.config);
    const loadedPaths = memoryManager
      ? Array.from(memoryManager.getLoadedPaths())
      : this.config.getGeminiMdFilePaths();
    const globalMemory = this.config.getGlobalMemory();
    const extensionMemory = memoryManager?.getExtensionMemory() ?? '';
    const projectMemory = this.config.getEnvironmentMemory();
    const userProjectMemory = memoryManager?.getUserProjectMemory() ?? '';

    const checkpointsDirectory =
      this.config.storage.getProjectTempCheckpointsDir();
    const checkpointCount = await this.countJsonFiles(checkpointsDirectory);
    const bridgeSnapshotPath = path.join(
      this.config.storage.getProjectTempDir(),
      'gemini-2',
      'query-runtime-bridge.json',
    );
    const sharedFabricStatus = await this.sharedFabricRegistry.getStatus();
    const loopSnapshot = await this.loopRuntimeService.getSnapshot();
    const automationStrategy = await new AutomationStrategyService(
      this.config,
    ).getState();

    return {
      sessionId: this.sessionStats.sessionId || this.config.getSessionId(),
      model,
      promptCount: this.sessionStats.promptCount ?? 0,
      lastPromptTokenCount,
      tokenLimit: limit,
      contextUsagePercent: percent(lastPromptTokenCount, limit),
      compressionThreshold,
      compressionThresholdTokenCount,
      compressionThresholdUsagePercent,
      activeSkillNames,
      discoveredAgentNames,
      memory: {
        jitEnabled: this.config.isJitContextEnabled(),
        loadedPathCount: loadedPaths.length,
        loadedPaths,
        globalChars: globalMemory.length,
        extensionChars: extensionMemory.length,
        projectChars: projectMemory.length,
        userProjectChars: userProjectMemory.length,
      },
      checkpoints: {
        enabled: this.config.getCheckpointingEnabled(),
        directory: checkpointsDirectory,
        count: checkpointCount,
      },
      sharedFabric: {
        available: sharedFabricStatus.available,
        indexedSkillCount: sharedFabricStatus.indexedSkillCount,
        routedDomainCount: sharedFabricStatus.routedDomainCount,
        workspaceOverlayPath: sharedFabricStatus.workspaceOverlayPath,
        workspaceOverlayExists: sharedFabricStatus.workspaceOverlayExists,
        workspaceRoot: sharedFabricStatus.workspaceRoot,
        globalRoot: sharedFabricStatus.globalRoot,
      },
      loop: loopSnapshot,
      automation: {
        loopMode: automationStrategy.loopMode,
        skillsMode: automationStrategy.skillsMode,
        agentsMode: automationStrategy.agentsMode,
        shellReplyMode: automationStrategy.shellReplyMode,
      },
      bridge: {
        snapshotPath: bridgeSnapshotPath,
        updatedAt: '',
      },
    };
  }

  async writeBridgeSnapshot(
    snapshot?: QueryRuntimeSnapshot,
  ): Promise<QueryRuntimeSnapshot> {
    const nextSnapshot = snapshot ?? (await this.collectStatus());
    const updatedSnapshot: QueryRuntimeSnapshot = {
      ...nextSnapshot,
      bridge: {
        ...nextSnapshot.bridge,
        updatedAt: new Date().toISOString(),
      },
    };

    await fs.mkdir(path.dirname(updatedSnapshot.bridge.snapshotPath), {
      recursive: true,
    });
    await fs.writeFile(
      updatedSnapshot.bridge.snapshotPath,
      `${JSON.stringify(updatedSnapshot, null, 2)}\n`,
      'utf-8',
    );

    return updatedSnapshot;
  }

  async captureSnapshot(): Promise<QueryRuntimeSnapshot> {
    const snapshot = await this.collectStatus();
    return this.writeBridgeSnapshot(snapshot);
  }

  private async countJsonFiles(directory: string): Promise<number> {
    try {
      const files = await fs.readdir(directory);
      return files.filter((file) => file.endsWith('.json')).length;
    } catch {
      return 0;
    }
  }
}
