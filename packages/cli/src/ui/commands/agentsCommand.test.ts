/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { agentsCommand } from './agentsCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { AGENT_TOOL_NAME, type Config } from '@google/gemini-cli-core';
import type { LoadedSettings } from '../../config/settings.js';
import { MessageType } from '../types.js';
import { enableAgent, disableAgent } from '../../utils/agentSettings.js';
import { renderAgentActionFeedback } from '../../utils/agentUtils.js';

vi.mock('../../utils/agentSettings.js', () => ({
  enableAgent: vi.fn(),
  disableAgent: vi.fn(),
}));

vi.mock('../../utils/agentUtils.js', () => ({
  renderAgentActionFeedback: vi.fn(),
}));

describe('agentsCommand', () => {
  let mockContext: ReturnType<typeof createMockCommandContext>;
  let mockConfig: {
    getAgentRegistry: ReturnType<typeof vi.fn>;
    config: Config;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfig = {
      getAgentRegistry: vi.fn().mockReturnValue({
        getAllDefinitions: vi.fn().mockReturnValue([]),
        getAllAgentNames: vi.fn().mockReturnValue([]),
        getAllDiscoveredAgentNames: vi.fn().mockReturnValue([]),
        getDefinition: vi.fn(),
        getDiscoveredDefinition: vi.fn(),
        reload: vi.fn(),
      }),
      get config() {
        return this as unknown as Config;
      },
    };

    mockContext = createMockCommandContext({
      services: {
        agentContext: mockConfig as unknown as Config,
        settings: {
          workspace: { path: '/mock/path' },
          merged: { agents: { overrides: {} } },
        } as unknown as LoadedSettings,
      },
    });
  });

  it('should show an error if config is not available', async () => {
    const contextWithoutConfig = createMockCommandContext({
      services: {
        agentContext: null,
      },
    });

    const result = await agentsCommand.action!(contextWithoutConfig, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    });
  });

  it('should show an error if agent registry is not available', async () => {
    mockConfig.getAgentRegistry = vi.fn().mockReturnValue(undefined);

    const result = await agentsCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Agent registry not found.',
    });
  });

  it('should call addItem with correct agents list', async () => {
    const mockAgents = [
      {
        name: 'agent1',
        displayName: 'Agent One',
        description: 'desc1',
        kind: 'local',
      },
      {
        name: 'agent2',
        displayName: undefined,
        description: 'desc2',
        kind: 'remote',
      },
    ];
    mockConfig.getAgentRegistry().getAllDefinitions.mockReturnValue(mockAgents);

    await agentsCommand.action!(mockContext, '');

    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.AGENTS_LIST,
        agents: mockAgents,
      }),
    );
  });

  it('should reload the agent registry when reload subcommand is called', async () => {
    const reloadSpy = vi.fn().mockResolvedValue(undefined);
    mockConfig.getAgentRegistry = vi.fn().mockReturnValue({
      reload: reloadSpy,
    });

    const reloadCommand = agentsCommand.subCommands?.find(
      (cmd) => cmd.name === 'reload',
    );
    expect(reloadCommand).toBeDefined();

    const result = await reloadCommand!.action!(mockContext, '');

    expect(reloadSpy).toHaveBeenCalled();
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: 'Reloading agent registry...',
      }),
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Agents reloaded successfully',
    });
  });

  it('should show an error if agent registry is not available during reload', async () => {
    mockConfig.getAgentRegistry = vi.fn().mockReturnValue(undefined);

    const reloadCommand = agentsCommand.subCommands?.find(
      (cmd) => cmd.name === 'reload',
    );
    const result = await reloadCommand!.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Agent registry not found.',
    });
  });

  it('should enable an agent successfully', async () => {
    const reloadSpy = vi.fn().mockResolvedValue(undefined);
    mockConfig.getAgentRegistry = vi.fn().mockReturnValue({
      getAllAgentNames: vi.fn().mockReturnValue([]),
      reload: reloadSpy,
    });
    // Add agent to disabled overrides so validation passes
    mockContext.services.settings.merged.agents.overrides['test-agent'] = {
      enabled: false,
    };

    vi.mocked(enableAgent).mockReturnValue({
      status: 'success',
      agentName: 'test-agent',
      action: 'enable',
      modifiedScopes: [],
      alreadyInStateScopes: [],
    });
    vi.mocked(renderAgentActionFeedback).mockReturnValue('Enabled test-agent.');

    const enableCommand = agentsCommand.subCommands?.find(
      (cmd) => cmd.name === 'enable',
    );
    expect(enableCommand).toBeDefined();

    const result = await enableCommand!.action!(mockContext, 'test-agent');

    expect(enableAgent).toHaveBeenCalledWith(
      mockContext.services.settings,
      'test-agent',
    );
    expect(reloadSpy).toHaveBeenCalled();
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: 'Enabling test-agent...',
      }),
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Enabled test-agent.',
    });
  });

  it('should handle no-op when enabling an agent', async () => {
    mockConfig
      .getAgentRegistry()
      .getAllAgentNames.mockReturnValue(['test-agent']);

    const enableCommand = agentsCommand.subCommands?.find(
      (cmd) => cmd.name === 'enable',
    );
    const result = await enableCommand!.action!(mockContext, 'test-agent');

    expect(enableAgent).not.toHaveBeenCalled();
    expect(mockContext.ui.addItem).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: "Agent 'test-agent' is already enabled.",
    });
  });

  it('should show usage error if no agent name provided for enable', async () => {
    const enableCommand = agentsCommand.subCommands?.find(
      (cmd) => cmd.name === 'enable',
    );
    const result = await enableCommand!.action!(mockContext, '   ');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Usage: /agents enable <agent-name>',
    });
  });

  it('should show an error if config is not available for enable', async () => {
    const contextWithoutConfig = createMockCommandContext({
      services: { agentContext: null },
    });
    const enableCommand = agentsCommand.subCommands?.find(
      (cmd) => cmd.name === 'enable',
    );
    const result = await enableCommand!.action!(contextWithoutConfig, 'test');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    });
  });

  it('should recommend agents for a query', async () => {
    mockConfig.getAgentRegistry = vi.fn().mockReturnValue({
      getAllDefinitions: vi.fn().mockReturnValue([
        {
          name: 'researcher',
          displayName: 'Researcher',
          description: 'Investigate code and collect evidence',
          kind: 'local',
        },
        {
          name: 'reviewer',
          displayName: 'Reviewer',
          description: 'Review code for regressions',
          kind: 'local',
        },
      ]),
    });

    const recommendCommand = agentsCommand.subCommands?.find(
      (cmd) => cmd.name === 'recommend',
    );
    const result = await recommendCommand!.action!(
      mockContext,
      'research code changes',
    );

    expect(result).toBeUndefined();
    expect(mockContext.ui.addItem).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: MessageType.INFO,
        text: expect.stringContaining('Recommended 2 agents'),
      }),
    );
    expect(mockContext.ui.addItem).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: MessageType.AGENTS_LIST,
        agents: [
          expect.objectContaining({ name: 'researcher' }),
          expect.objectContaining({ name: 'reviewer' }),
        ],
      }),
    );
  });

  it('should fork a task through the invoke_agent tool', async () => {
    mockConfig.getAgentRegistry = vi.fn().mockReturnValue({
      getDefinition: vi.fn().mockReturnValue({
        name: 'researcher',
        displayName: 'Researcher',
        description: 'Investigate code and collect evidence',
        kind: 'local',
      }),
      getDiscoveredDefinition: vi.fn().mockReturnValue(undefined),
    });

    const taskCommand = agentsCommand.subCommands?.find(
      (cmd) => cmd.name === 'task',
    );
    const result = await taskCommand!.action!(
      mockContext,
      'researcher inspect the auth flow',
    );

    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: 'Forking task to agent "researcher".',
      }),
    );
    expect(result).toEqual({
      type: 'tool',
      toolName: AGENT_TOOL_NAME,
      toolArgs: {
        agent_name: 'researcher',
        prompt: 'inspect the auth flow',
      },
    });
  });

  it('should disable an agent successfully', async () => {
    const reloadSpy = vi.fn().mockResolvedValue(undefined);
    mockConfig.getAgentRegistry = vi.fn().mockReturnValue({
      getAllAgentNames: vi.fn().mockReturnValue(['test-agent']),
      reload: reloadSpy,
    });
    vi.mocked(disableAgent).mockReturnValue({
      status: 'success',
      agentName: 'test-agent',
      action: 'disable',
      modifiedScopes: [],
      alreadyInStateScopes: [],
    });
    vi.mocked(renderAgentActionFeedback).mockReturnValue(
      'Disabled test-agent.',
    );

    const disableCommand = agentsCommand.subCommands?.find(
      (cmd) => cmd.name === 'disable',
    );
    expect(disableCommand).toBeDefined();

    const result = await disableCommand!.action!(mockContext, 'test-agent');

    expect(disableAgent).toHaveBeenCalledWith(
      mockContext.services.settings,
      'test-agent',
      expect.anything(), // Scope is derived in the command
    );
    expect(reloadSpy).toHaveBeenCalled();
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: 'Disabling test-agent...',
      }),
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Disabled test-agent.',
    });
  });

  it('should show info message if agent is already disabled', async () => {
    mockConfig.getAgentRegistry().getAllAgentNames.mockReturnValue([]);
    mockContext.services.settings.merged.agents.overrides['test-agent'] = {
      enabled: false,
    };

    const disableCommand = agentsCommand.subCommands?.find(
      (cmd) => cmd.name === 'disable',
    );
    const result = await disableCommand!.action!(mockContext, 'test-agent');

    expect(disableAgent).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: "Agent 'test-agent' is already disabled.",
    });
  });

  it('should show error if agent is not found when disabling', async () => {
    mockConfig.getAgentRegistry().getAllAgentNames.mockReturnValue([]);

    const disableCommand = agentsCommand.subCommands?.find(
      (cmd) => cmd.name === 'disable',
    );
    const result = await disableCommand!.action!(mockContext, 'test-agent');

    expect(disableAgent).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: "Agent 'test-agent' not found.",
    });
  });

  it('should show usage error if no agent name provided for disable', async () => {
    const disableCommand = agentsCommand.subCommands?.find(
      (cmd) => cmd.name === 'disable',
    );
    const result = await disableCommand!.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Usage: /agents disable <agent-name>',
    });
  });

  it('should show an error if config is not available for disable', async () => {
    const contextWithoutConfig = createMockCommandContext({
      services: { agentContext: null },
    });
    const disableCommand = agentsCommand.subCommands?.find(
      (cmd) => cmd.name === 'disable',
    );
    const result = await disableCommand!.action!(contextWithoutConfig, 'test');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    });
  });

  describe('config sub-command', () => {
    it('should return dialog action for a valid agent', async () => {
      const mockDefinition = {
        name: 'test-agent',
        displayName: 'Test Agent',
        description: 'test desc',
        kind: 'local',
      };
      mockConfig.getAgentRegistry = vi.fn().mockReturnValue({
        getDiscoveredDefinition: vi.fn().mockReturnValue(mockDefinition),
      });

      const configCommand = agentsCommand.subCommands?.find(
        (cmd) => cmd.name === 'config',
      );
      expect(configCommand).toBeDefined();

      const result = await configCommand!.action!(mockContext, 'test-agent');

      expect(result).toEqual({
        type: 'dialog',
        dialog: 'agentConfig',
        props: {
          name: 'test-agent',
          displayName: 'Test Agent',
          definition: mockDefinition,
        },
      });
    });

    it('should use name as displayName if displayName is missing', async () => {
      const mockDefinition = {
        name: 'test-agent',
        description: 'test desc',
        kind: 'local',
      };
      mockConfig.getAgentRegistry = vi.fn().mockReturnValue({
        getDiscoveredDefinition: vi.fn().mockReturnValue(mockDefinition),
      });

      const configCommand = agentsCommand.subCommands?.find(
        (cmd) => cmd.name === 'config',
      );
      const result = await configCommand!.action!(mockContext, 'test-agent');

      expect(result).toEqual({
        type: 'dialog',
        dialog: 'agentConfig',
        props: {
          name: 'test-agent',
          displayName: 'test-agent', // Falls back to name
          definition: mockDefinition,
        },
      });
    });

    it('should show error if agent is not found', async () => {
      mockConfig.getAgentRegistry = vi.fn().mockReturnValue({
        getDiscoveredDefinition: vi.fn().mockReturnValue(undefined),
      });

      const configCommand = agentsCommand.subCommands?.find(
        (cmd) => cmd.name === 'config',
      );
      const result = await configCommand!.action!(mockContext, 'non-existent');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: "Agent 'non-existent' not found.",
      });
    });

    it('should show usage error if no agent name provided', async () => {
      const configCommand = agentsCommand.subCommands?.find(
        (cmd) => cmd.name === 'config',
      );
      const result = await configCommand!.action!(mockContext, '  ');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'Usage: /agents config <agent-name>',
      });
    });

    it('should show an error if config is not available', async () => {
      const contextWithoutConfig = createMockCommandContext({
        services: { agentContext: null },
      });
      const configCommand = agentsCommand.subCommands?.find(
        (cmd) => cmd.name === 'config',
      );
      const result = await configCommand!.action!(contextWithoutConfig, 'test');
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'Config not loaded.',
      });
    });

    it('should provide completions for discovered agents', async () => {
      mockConfig.getAgentRegistry = vi.fn().mockReturnValue({
        getAllDiscoveredAgentNames: vi
          .fn()
          .mockReturnValue(['agent1', 'agent2', 'other']),
      });

      const configCommand = agentsCommand.subCommands?.find(
        (cmd) => cmd.name === 'config',
      );
      expect(configCommand?.completion).toBeDefined();

      const completions = await configCommand!.completion!(mockContext, 'age');
      expect(completions).toEqual(['agent1', 'agent2']);
    });
  });
});
