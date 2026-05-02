/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AGENT_TOOL_NAME } from '@google/gemini-cli-core';
import type {
  SlashCommand,
  CommandContext,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import {
  MessageType,
  type HistoryItemAgentsList,
  type HistoryItemInfo,
} from '../types.js';
import { SettingScope } from '../../config/settings.js';
import { disableAgent, enableAgent } from '../../utils/agentSettings.js';
import { renderAgentActionFeedback } from '../../utils/agentUtils.js';
import { parseSlashCommand } from '../../utils/commands.js';
import {
  AutomationStrategyService,
  describeAgentsMode,
  type AgentAutomationMode,
} from '../../services/automationStrategyService.js';

function getAutomationStrategyService(
  context: CommandContext,
): AutomationStrategyService | null {
  const config = context.services.agentContext?.config;
  return config ? new AutomationStrategyService(config) : null;
}

function isAgentsMode(value: string): value is AgentAutomationMode {
  return value === 'manual' || value === 'auto' || value === 'full';
}

const agentsListCommand: SlashCommand = {
  name: 'list',
  description: 'List available local and remote agents',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (context: CommandContext) => {
    const config = context.services.agentContext?.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Config not loaded.',
      };
    }

    const agentRegistry = config.getAgentRegistry();
    if (!agentRegistry) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Agent registry not found.',
      };
    }

    const agents = agentRegistry.getAllDefinitions().map((def) => ({
      name: def.name,
      displayName: def.displayName,
      description: def.description,
      kind: def.kind,
    }));

    const agentsListItem: HistoryItemAgentsList = {
      type: MessageType.AGENTS_LIST,
      agents,
    };

    context.ui.addItem(agentsListItem);

    return;
  },
};

async function modeAction(
  context: CommandContext,
  mode: AgentAutomationMode,
): Promise<SlashCommandActionReturn | void> {
  const strategyService = getAutomationStrategyService(context);
  if (!strategyService) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    };
  }

  await strategyService.setAgentsMode(mode);
  context.ui.addItem({
    type: MessageType.INFO,
    text: `Agent automation set to ${mode}.`,
    secondaryText: describeAgentsMode(mode),
  } as HistoryItemInfo);
}

async function statusAction(
  context: CommandContext,
): Promise<SlashCommandActionReturn | void> {
  const config = context.services.agentContext?.config;
  const strategyService = getAutomationStrategyService(context);
  if (!config || !strategyService) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    };
  }

  const agentRegistry = config.getAgentRegistry();
  if (!agentRegistry) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Agent registry not found.',
    };
  }

  const strategy = await strategyService.getState();
  const agents = agentRegistry.getAllDefinitions().map((def) => ({
    name: def.name,
    displayName: def.displayName,
    description: def.description,
    kind: def.kind,
  }));

  context.ui.addItem({
    type: MessageType.INFO,
    text: `Agents mode: ${strategy.agentsMode}.`,
    secondaryText: describeAgentsMode(strategy.agentsMode),
  } as HistoryItemInfo);
  context.ui.addItem({
    type: MessageType.INFO,
    text: `${agents.length} agent${agents.length === 1 ? '' : 's'} available.`,
    secondaryText:
      strategy.agentsMode === 'manual'
        ? 'Use /agents task <agent-name> <prompt> when you want to delegate explicitly.'
        : 'Gemini-2 will follow this policy when deciding whether to delegate to subagents.',
  } as HistoryItemInfo);
}

async function enableAction(
  context: CommandContext,
  args: string,
): Promise<SlashCommandActionReturn | void> {
  const config = context.services.agentContext?.config;
  const { settings } = context.services;
  if (!config) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    };
  }

  const agentName = args.trim();
  if (!agentName) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Usage: /agents enable <agent-name>',
    };
  }

  const agentRegistry = config.getAgentRegistry();
  if (!agentRegistry) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Agent registry not found.',
    };
  }

  const allAgents = agentRegistry.getAllAgentNames();
  const overrides = settings.merged.agents.overrides;
  const disabledAgents = Object.keys(overrides).filter(
    (name) => overrides[name]?.enabled === false,
  );

  if (allAgents.includes(agentName) && !disabledAgents.includes(agentName)) {
    return {
      type: 'message',
      messageType: 'info',
      content: `Agent '${agentName}' is already enabled.`,
    };
  }

  if (!disabledAgents.includes(agentName) && !allAgents.includes(agentName)) {
    return {
      type: 'message',
      messageType: 'error',
      content: `Agent '${agentName}' not found.`,
    };
  }

  const result = enableAgent(settings, agentName);

  if (result.status === 'no-op') {
    return {
      type: 'message',
      messageType: 'info',
      content: renderAgentActionFeedback(result, (l, p) => `${l} (${p})`),
    };
  }

  context.ui.addItem({
    type: MessageType.INFO,
    text: `Enabling ${agentName}...`,
  });
  await agentRegistry.reload();

  return {
    type: 'message',
    messageType: 'info',
    content: renderAgentActionFeedback(result, (l, p) => `${l} (${p})`),
  };
}

async function disableAction(
  context: CommandContext,
  args: string,
): Promise<SlashCommandActionReturn | void> {
  const config = context.services.agentContext?.config;
  const { settings } = context.services;
  if (!config) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    };
  }

  const agentName = args.trim();
  if (!agentName) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Usage: /agents disable <agent-name>',
    };
  }

  const agentRegistry = config.getAgentRegistry();
  if (!agentRegistry) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Agent registry not found.',
    };
  }

  const allAgents = agentRegistry.getAllAgentNames();
  const overrides = settings.merged.agents.overrides;
  const disabledAgents = Object.keys(overrides).filter(
    (name) => overrides[name]?.enabled === false,
  );

  if (disabledAgents.includes(agentName)) {
    return {
      type: 'message',
      messageType: 'info',
      content: `Agent '${agentName}' is already disabled.`,
    };
  }

  if (!allAgents.includes(agentName)) {
    return {
      type: 'message',
      messageType: 'error',
      content: `Agent '${agentName}' not found.`,
    };
  }

  const scope = context.services.settings.workspace.path
    ? SettingScope.Workspace
    : SettingScope.User;
  const result = disableAgent(settings, agentName, scope);

  if (result.status === 'no-op') {
    return {
      type: 'message',
      messageType: 'info',
      content: renderAgentActionFeedback(result, (l, p) => `${l} (${p})`),
    };
  }

  context.ui.addItem({
    type: MessageType.INFO,
    text: `Disabling ${agentName}...`,
  });
  await agentRegistry.reload();

  return {
    type: 'message',
    messageType: 'info',
    content: renderAgentActionFeedback(result, (l, p) => `${l} (${p})`),
  };
}

async function configAction(
  context: CommandContext,
  args: string,
): Promise<SlashCommandActionReturn | void> {
  const config = context.services.agentContext?.config;
  if (!config) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    };
  }

  const agentName = args.trim();
  if (!agentName) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Usage: /agents config <agent-name>',
    };
  }

  const agentRegistry = config.getAgentRegistry();
  if (!agentRegistry) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Agent registry not found.',
    };
  }

  const definition = agentRegistry.getDiscoveredDefinition(agentName);
  if (!definition) {
    return {
      type: 'message',
      messageType: 'error',
      content: `Agent '${agentName}' not found.`,
    };
  }

  const displayName = definition.displayName || agentName;

  return {
    type: 'dialog',
    dialog: 'agentConfig',
    props: {
      name: agentName,
      displayName,
      definition,
    },
  };
}

function completeAgentsToEnable(context: CommandContext, partialArg: string) {
  const config = context.services.agentContext?.config;
  const { settings } = context.services;
  if (!config) return [];

  const overrides = settings.merged.agents.overrides;
  const disabledAgents = Object.entries(overrides)
    .filter(([_, override]) => override?.enabled === false)
    .map(([name]) => name);

  return disabledAgents.filter((name) => name.startsWith(partialArg));
}

function completeAgentsToDisable(context: CommandContext, partialArg: string) {
  const config = context.services.agentContext?.config;
  if (!config) return [];

  const agentRegistry = config.getAgentRegistry();
  const allAgents = agentRegistry ? agentRegistry.getAllAgentNames() : [];
  return allAgents.filter((name: string) => name.startsWith(partialArg));
}

function completeAllAgents(context: CommandContext, partialArg: string) {
  const config = context.services.agentContext?.config;
  if (!config) return [];

  const agentRegistry = config.getAgentRegistry();
  const allAgents = agentRegistry?.getAllDiscoveredAgentNames() ?? [];
  return allAgents.filter((name: string) => name.startsWith(partialArg));
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(/[^a-z0-9\u4e00-\u9fff-]+/i)
    .filter(Boolean);
}

async function recommendAction(
  context: CommandContext,
  args: string,
): Promise<SlashCommandActionReturn | void> {
  const config = context.services.agentContext?.config;
  if (!config) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    };
  }

  const query = args.trim();
  if (!query) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Usage: /agents recommend <query>',
    };
  }

  const agentRegistry = config.getAgentRegistry();
  if (!agentRegistry) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Agent registry not found.',
    };
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
        definition,
        score,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ definition }) => ({
      name: definition.name,
      displayName: definition.displayName,
      description: definition.description,
      kind: definition.kind,
    }));

  if (ranked.length === 0) {
    return {
      type: 'message',
      messageType: 'info',
      content: `No agent recommendations were found for "${query}".`,
    };
  }

  context.ui.addItem({
    type: MessageType.INFO,
    text: `Recommended ${ranked.length} agent${ranked.length === 1 ? '' : 's'} for "${query}".`,
    secondaryText:
      'Use /agents task <agent-name> <prompt> to fork one of these as a focused subagent task.',
  } as HistoryItemInfo);
  context.ui.addItem({
    type: MessageType.AGENTS_LIST,
    agents: ranked,
  } as HistoryItemAgentsList);
}

async function taskAction(
  context: CommandContext,
  args: string,
): Promise<SlashCommandActionReturn | void> {
  const config = context.services.agentContext?.config;
  if (!config) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    };
  }

  const trimmedArgs = args.trim();
  if (!trimmedArgs) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Usage: /agents task <agent-name> <prompt>',
    };
  }

  const splitIndex = trimmedArgs.indexOf(' ');
  if (splitIndex === -1) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Usage: /agents task <agent-name> <prompt>',
    };
  }

  const agentName = trimmedArgs.slice(0, splitIndex).trim();
  const prompt = trimmedArgs.slice(splitIndex + 1).trim();
  if (!agentName || !prompt) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Usage: /agents task <agent-name> <prompt>',
    };
  }

  const agentRegistry = config.getAgentRegistry();
  if (!agentRegistry) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Agent registry not found.',
    };
  }

  const definition =
    agentRegistry.getDefinition(agentName) ||
    agentRegistry.getDiscoveredDefinition(agentName);
  if (!definition) {
    return {
      type: 'message',
      messageType: 'error',
      content: `Agent '${agentName}' not found.`,
    };
  }

  context.ui.addItem({
    type: MessageType.INFO,
    text: `Forking task to agent "${agentName}".`,
    secondaryText:
      'This uses the native invoke_agent tool, so the work runs as an explicit subagent task instead of hidden prompt steering.',
  } as HistoryItemInfo);

  return {
    type: 'tool',
    toolName: AGENT_TOOL_NAME,
    toolArgs: {
      agent_name: agentName,
      prompt,
    },
  };
}

function completeAgentTask(context: CommandContext, partialArg: string) {
  const trimmed = partialArg.trimStart();
  if (!trimmed || !trimmed.includes(' ')) {
    return completeAllAgents(context, trimmed);
  }
  return [];
}

const enableCommand: SlashCommand = {
  name: 'enable',
  description: 'Enable a disabled agent',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: enableAction,
  completion: completeAgentsToEnable,
};

const disableCommand: SlashCommand = {
  name: 'disable',
  description: 'Disable an enabled agent',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: disableAction,
  completion: completeAgentsToDisable,
};

const configCommand: SlashCommand = {
  name: 'config',
  description: 'Configure an agent',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: configAction,
  completion: completeAllAgents,
};

const recommendCommand: SlashCommand = {
  name: 'recommend',
  description: 'Recommend agents for a task',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: recommendAction,
};

const taskCommand: SlashCommand = {
  name: 'task',
  description: 'Fork a task to a subagent',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: taskAction,
  completion: completeAgentTask,
};

const agentsReloadCommand: SlashCommand = {
  name: 'reload',
  altNames: ['refresh'],
  description: 'Reload the agent registry',
  kind: CommandKind.BUILT_IN,
  action: async (context: CommandContext) => {
    const config = context.services.agentContext?.config;
    const agentRegistry = config?.getAgentRegistry();
    if (!agentRegistry) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Agent registry not found.',
      };
    }

    context.ui.addItem({
      type: MessageType.INFO,
      text: 'Reloading agent registry...',
    });

    await agentRegistry.reload();

    return {
      type: 'message',
      messageType: 'info',
      content: 'Agents reloaded successfully',
    };
  },
};

export const agentsCommand: SlashCommand = {
  name: 'agents',
  description:
    'Set agent automation or manage agents. Usage: /agents [manual | auto | full | list | recommend | task]',
  kind: CommandKind.BUILT_IN,
  subCommands: [
    {
      name: 'manual',
      description: 'Turn off automatic subagent routing and delegate manually.',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: (context) => modeAction(context, 'manual'),
    },
    {
      name: 'auto',
      description: 'Let Gemini-2 decide when to recommend or use subagents.',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: (context) => modeAction(context, 'auto'),
    },
    {
      name: 'full',
      description:
        'Require Gemini-2 to choose and use suitable subagents when available.',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: (context) => modeAction(context, 'full'),
    },
    agentsListCommand,
    agentsReloadCommand,
    enableCommand,
    disableCommand,
    configCommand,
    recommendCommand,
    taskCommand,
  ],
  action: async (context: CommandContext, args) => {
    const trimmedArgs = args.trim();
    if (isAgentsMode(trimmedArgs)) {
      return modeAction(context, trimmedArgs);
    }
    if (trimmedArgs) {
      const parsed = parseSlashCommand(
        `/${trimmedArgs}`,
        agentsCommand.subCommands!,
      );
      if (parsed.commandToExecute?.action) {
        return parsed.commandToExecute.action(context, parsed.args);
      }
    }
    return statusAction(context);
  },
};
