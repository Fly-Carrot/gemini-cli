/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ACTIVATE_SKILL_TOOL_NAME,
  getAdminErrorMessage,
  getErrorMessage,
  type SkillDefinition,
} from '@google/gemini-cli-core';
import {
  type CommandContext,
  type SlashCommand,
  type SlashCommandActionReturn,
  CommandKind,
} from './types.js';
import {
  type HistoryItemInfo,
  type HistoryItemSkillsList,
  MessageType,
} from '../types.js';
import { disableSkill, enableSkill } from '../../utils/skillSettings.js';
import {
  linkSkill,
  renderSkillActionFeedback,
} from '../../utils/skillUtils.js';
import { SettingScope } from '../../config/settings.js';
import {
  requestConsentInteractive,
  skillsConsentString,
} from '../../config/extensions/consent.js';
import { parseSlashCommand } from '../../utils/commands.js';
import {
  SharedFabricRegistry,
  type SharedFabricSkillCandidate,
} from '../../services/sharedFabricRegistry.js';
import {
  AutomationStrategyService,
  describeSkillsMode,
  type SkillAutomationMode,
} from '../../services/automationStrategyService.js';

function getSharedFabricRegistry(
  context: CommandContext,
): SharedFabricRegistry {
  const settingsWithWorkspace = context.services.settings as {
    workspace?: { path?: string };
  };
  return new SharedFabricRegistry({
    workspaceRoot:
      settingsWithWorkspace.workspace?.path ||
      process.env['GEMINI2_SHARED_FABRIC_WORKSPACE'] ||
      process.cwd(),
  });
}

function getAutomationStrategyService(
  context: CommandContext,
): AutomationStrategyService | null {
  const config = context.services.agentContext?.config;
  return config ? new AutomationStrategyService(config) : null;
}

function isSkillsMode(value: string): value is SkillAutomationMode {
  return value === 'manual' || value === 'auto' || value === 'full';
}

function toSkillsListItem(
  skills: SkillDefinition[],
  showDescriptions: boolean,
): HistoryItemSkillsList {
  return {
    type: MessageType.SKILLS_LIST,
    skills,
    showDescriptions,
  };
}

function getSkillManager(context: CommandContext) {
  return context.services.agentContext?.config.getSkillManager();
}

async function listAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const subArgs = args.trim().split(/\s+/).filter(Boolean);

  // Default to SHOWING descriptions. The user can hide them with 'nodesc'.
  let useShowDescriptions = true;
  let showAll = false;

  for (const arg of subArgs) {
    if (arg === 'nodesc' || arg === '--nodesc') {
      useShowDescriptions = false;
    } else if (arg === 'all' || arg === '--all') {
      showAll = true;
    }
  }

  const skillManager = getSkillManager(context);
  if (!skillManager) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Could not retrieve skill manager.',
    });
    return;
  }

  const skills = showAll
    ? skillManager.getAllSkills()
    : skillManager.getAllSkills().filter((s) => !s.isBuiltin);

  context.ui.addItem(toSkillsListItem(skills, useShowDescriptions));
}

async function activeAction(
  context: CommandContext,
): Promise<void | SlashCommandActionReturn> {
  const skillManager = getSkillManager(context);
  if (!skillManager) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Could not retrieve skill manager.',
    });
    return;
  }

  const activeSkills = skillManager
    .getAllSkills()
    .filter((skill) => skillManager.isSkillActive(skill.name));

  if (activeSkills.length === 0) {
    context.ui.addItem({
      type: MessageType.INFO,
      text: 'No skills are currently active in this session.',
      secondaryText:
        'Run /skills use <name> or invoke a skill slash command to activate one.',
    } as HistoryItemInfo);
    return;
  }

  context.ui.addItem({
    type: MessageType.INFO,
    text: `${activeSkills.length} active skill${
      activeSkills.length > 1 ? 's' : ''
    } loaded into this session.`,
    secondaryText:
      'These are the skills whose guidance is currently available to the model.',
  } as HistoryItemInfo);
  context.ui.addItem(toSkillsListItem(activeSkills, true));
}

async function modeAction(
  context: CommandContext,
  mode: SkillAutomationMode,
): Promise<void | SlashCommandActionReturn> {
  const strategyService = getAutomationStrategyService(context);
  if (!strategyService) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    };
  }

  await strategyService.setSkillsMode(mode);
  context.ui.addItem({
    type: MessageType.INFO,
    text: `Skill automation set to ${mode}.`,
    secondaryText: describeSkillsMode(mode),
  } as HistoryItemInfo);
}

async function statusAction(
  context: CommandContext,
): Promise<void | SlashCommandActionReturn> {
  const strategyService = getAutomationStrategyService(context);
  const skillManager = getSkillManager(context);
  if (!strategyService || !skillManager) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Could not retrieve skill configuration.',
    };
  }

  const strategy = await strategyService.getState();
  const activeSkills = skillManager
    .getAllSkills()
    .filter((skill) => skillManager.isSkillActive(skill.name));

  context.ui.addItem({
    type: MessageType.INFO,
    text: `Skills mode: ${strategy.skillsMode}.`,
    secondaryText: describeSkillsMode(strategy.skillsMode),
  } as HistoryItemInfo);
  context.ui.addItem({
    type: MessageType.INFO,
    text:
      activeSkills.length > 0
        ? `${activeSkills.length} skill${
            activeSkills.length > 1 ? 's are' : ' is'
          } active in this session.`
        : 'No skills are currently active in this session.',
    secondaryText:
      strategy.skillsMode === 'manual'
        ? 'Use /skills use <name> when you want to bring a specific skill into the conversation.'
        : 'Gemini-2 will follow this policy when deciding whether to load skills automatically.',
  } as HistoryItemInfo);
}

async function searchAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const query = args.trim();
  if (!query) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Usage: /skills search <query>',
    });
    return;
  }

  const registry = getSharedFabricRegistry(context);
  const matches = await registry.searchSkills(query, 12);

  if (matches.length === 0) {
    context.ui.addItem({
      type: MessageType.INFO,
      text: `No shared-fabric skills matched "${query}".`,
      secondaryText:
        'Try a broader query or use /skills recommend <query> for routed suggestions.',
    } as HistoryItemInfo);
    return;
  }

  context.ui.addItem({
    type: MessageType.INFO,
    text: `Found ${matches.length} shared-fabric skill${
      matches.length > 1 ? 's' : ''
    } for "${query}".`,
    secondaryText:
      'Use /skills use <name> to load one into this Gemini-2 session.',
  } as HistoryItemInfo);
  context.ui.addItem(toSkillsListItem(matches, true));
}

async function recommendAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const query = args.trim();
  if (!query) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Usage: /skills recommend <query>',
    });
    return;
  }

  const registry = getSharedFabricRegistry(context);
  const route = await registry.recommendSkills(query, 8);

  if (route.skills.length === 0) {
    context.ui.addItem({
      type: MessageType.INFO,
      text: `No routed skill recommendations were found for "${query}".`,
      secondaryText:
        'Try /skills search <query> or inspect /fabric status for shared-fabric readiness.',
    } as HistoryItemInfo);
    return;
  }

  const domainText = route.domain ? ` Routed to ${route.domain.label}.` : '';

  context.ui.addItem({
    type: MessageType.INFO,
    text: `Recommended ${route.skills.length} skill${
      route.skills.length > 1 ? 's' : ''
    } for "${query}".${domainText}`,
    secondaryText:
      route.domain?.summary ||
      'Use /skills use <name> to pull one of these into the current session.',
  } as HistoryItemInfo);
  context.ui.addItem(toSkillsListItem(route.skills, true));
}

async function useAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const [skillName = '', ...promptParts] = args
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!skillName) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Usage: /skills use <name> [task prompt]',
    });
    return;
  }

  const config = context.services.agentContext?.config;
  const skillManager = config?.getSkillManager();
  if (!config || !skillManager) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Could not retrieve skill configuration.',
    });
    return;
  }

  let skill = skillManager.getSkill(skillName);
  let loadedCandidate: SharedFabricSkillCandidate | null = null;

  if (!skill) {
    const registry = getSharedFabricRegistry(context);
    loadedCandidate = await registry.findSkillByName(skillName);
    if (!loadedCandidate) {
      const suggestions = await registry.searchSkills(skillName, 3);
      const suggestionText =
        suggestions.length > 0
          ? ` Did you mean ${suggestions.map((entry) => `"${entry.name}"`).join(', ')}?`
          : '';

      context.ui.addItem({
        type: MessageType.ERROR,
        text: `Shared-fabric skill "${skillName}" was not found.${suggestionText}`,
      });
      return;
    }

    const loadedSkill = await registry.loadSkillDefinition(
      loadedCandidate.name,
    );
    if (!loadedSkill) {
      context.ui.addItem({
        type: MessageType.ERROR,
        text: `Failed to load shared-fabric skill "${loadedCandidate.name}" from disk.`,
      });
      return;
    }

    skillManager.addSkills([loadedSkill]);
    context.ui.reloadCommands();
    skill = loadedSkill;
  }

  const prompt = promptParts.join(' ').trim();
  const isSharedFabricSkill = !!loadedCandidate;

  context.ui.addItem({
    type: MessageType.INFO,
    text: isSharedFabricSkill
      ? `Loaded shared-fabric skill "${skill.name}" into this session.`
      : `Using skill "${skill.name}" in this session.`,
    secondaryText: isSharedFabricSkill
      ? `Source: ${loadedCandidate?.location}. Run /skills active to inspect current activations.`
      : 'Run /skills active to inspect current activations.',
  } as HistoryItemInfo);

  return {
    type: 'tool',
    toolName: ACTIVATE_SKILL_TOOL_NAME,
    toolArgs: { name: skill.name },
    postSubmitPrompt:
      prompt.length > 0 ? prompt : `Use the skill ${skill.name}`,
  };
}

async function linkAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const parts = args.trim().split(/\s+/);
  const sourcePath = parts[0];

  if (!sourcePath) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Usage: /skills link <path> [--scope user|workspace]',
    });
    return;
  }

  let scopeArg = 'user';
  if (parts.length >= 3 && parts[1] === '--scope') {
    scopeArg = parts[2];
  } else if (parts.length >= 2 && parts[1].startsWith('--scope=')) {
    scopeArg = parts[1].split('=')[1];
  }

  const scope = scopeArg === 'workspace' ? 'workspace' : 'user';

  try {
    await linkSkill(
      sourcePath,
      scope,
      (msg) =>
        context.ui.addItem({
          type: MessageType.INFO,
          text: msg,
        }),
      async (skills, targetDir) => {
        const consentString = await skillsConsentString(
          skills,
          sourcePath,
          targetDir,
          true,
        );
        return requestConsentInteractive(
          consentString,
          context.ui.setConfirmationRequest.bind(context.ui),
        );
      },
    );

    context.ui.addItem({
      type: MessageType.INFO,
      text: `Successfully linked skills from "${sourcePath}" (${scope}).`,
    });

    if (context.services.agentContext?.config) {
      await context.services.agentContext.config.reloadSkills();
    }
  } catch (error) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: `Failed to link skills: ${getErrorMessage(error)}`,
    });
  }
}

async function disableAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const skillName = args.trim();
  if (!skillName) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Please provide a skill name to disable.',
    });
    return;
  }
  const skillManager = getSkillManager(context);
  if (skillManager?.isAdminEnabled() === false) {
    context.ui.addItem(
      {
        type: MessageType.ERROR,
        text: getAdminErrorMessage(
          'Agent skills',
          context.services.agentContext?.config ?? undefined,
        ),
      },
      Date.now(),
    );
    return;
  }

  const skill = skillManager?.getSkill(skillName);
  if (!skill) {
    context.ui.addItem(
      {
        type: MessageType.ERROR,
        text: `Skill "${skillName}" not found.`,
      },
      Date.now(),
    );
    return;
  }

  const scope = context.services.settings.workspace.path
    ? SettingScope.Workspace
    : SettingScope.User;

  const result = disableSkill(context.services.settings, skillName, scope);

  let feedback = renderSkillActionFeedback(
    result,
    (label, pathToSetting) => `${label} (${pathToSetting})`,
  );
  if (result.status === 'success' || result.status === 'no-op') {
    feedback +=
      ' You can run "/skills reload" to refresh your current instance.';
  }

  context.ui.addItem({
    type: MessageType.INFO,
    text: feedback,
  });
}

async function enableAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const skillName = args.trim();
  if (!skillName) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Please provide a skill name to enable.',
    });
    return;
  }

  const skillManager = getSkillManager(context);
  if (skillManager?.isAdminEnabled() === false) {
    context.ui.addItem(
      {
        type: MessageType.ERROR,
        text: getAdminErrorMessage(
          'Agent skills',
          context.services.agentContext?.config ?? undefined,
        ),
      },
      Date.now(),
    );
    return;
  }

  const result = enableSkill(context.services.settings, skillName);

  let feedback = renderSkillActionFeedback(
    result,
    (label, pathToSetting) => `${label} (${pathToSetting})`,
  );
  if (result.status === 'success' || result.status === 'no-op') {
    feedback +=
      ' You can run "/skills reload" to refresh your current instance.';
  }

  context.ui.addItem({
    type: MessageType.INFO,
    text: feedback,
  });
}

async function reloadAction(
  context: CommandContext,
): Promise<void | SlashCommandActionReturn> {
  const config = context.services.agentContext?.config;
  if (!config) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Could not retrieve configuration.',
    });
    return;
  }

  const skillManager = config.getSkillManager();
  const beforeNames = new Set(skillManager.getSkills().map((s) => s.name));

  const startTime = Date.now();
  let pendingItemSet = false;
  const pendingTimeout = setTimeout(() => {
    context.ui.setPendingItem({
      type: MessageType.INFO,
      text: 'Reloading agent skills...',
    });
    pendingItemSet = true;
  }, 100);

  try {
    await config.reloadSkills();

    clearTimeout(pendingTimeout);
    if (pendingItemSet) {
      // If we showed the pending item, make sure it stays for at least 500ms
      // total to avoid a "flicker" where it appears and immediately disappears.
      const elapsed = Date.now() - startTime;
      const minVisibleDuration = 500;
      if (elapsed < minVisibleDuration) {
        await new Promise((resolve) =>
          setTimeout(resolve, minVisibleDuration - elapsed),
        );
      }
      context.ui.setPendingItem(null);
    }

    context.ui.reloadCommands();

    const afterSkills = skillManager.getSkills();
    const afterNames = new Set(afterSkills.map((s) => s.name));

    const added = afterSkills.filter((s) => !beforeNames.has(s.name));
    const removedCount = [...beforeNames].filter(
      (name) => !afterNames.has(name),
    ).length;

    let successText = 'Agent skills reloaded successfully.';
    const details: string[] = [];

    if (added.length > 0) {
      details.push(
        `${added.length} newly available skill${added.length > 1 ? 's' : ''}`,
      );
    }
    if (removedCount > 0) {
      details.push(
        `${removedCount} skill${removedCount > 1 ? 's' : ''} no longer available`,
      );
    }

    if (details.length > 0) {
      successText += ` ${details.join(' and ')}.`;
    }

    context.ui.addItem({
      type: 'info',
      text: successText,
      icon: '✓ ',
      color: 'green',
    } as HistoryItemInfo);
  } catch (error) {
    clearTimeout(pendingTimeout);
    if (pendingItemSet) {
      context.ui.setPendingItem(null);
    }
    context.ui.addItem({
      type: MessageType.ERROR,
      text: `Failed to reload skills: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

function disableCompletion(
  context: CommandContext,
  partialArg: string,
): string[] {
  const skillManager = getSkillManager(context);
  if (!skillManager) {
    return [];
  }
  return skillManager
    .getAllSkills()
    .filter((s) => !s.disabled && s.name.startsWith(partialArg))
    .map((s) => s.name);
}

function enableCompletion(
  context: CommandContext,
  partialArg: string,
): string[] {
  const skillManager = getSkillManager(context);
  if (!skillManager) {
    return [];
  }
  return skillManager
    .getAllSkills()
    .filter((s) => s.disabled && s.name.startsWith(partialArg))
    .map((s) => s.name);
}

async function useCompletion(
  context: CommandContext,
  partialArg: string,
): Promise<string[]> {
  const skillManager = getSkillManager(context);
  const loadedSkills =
    skillManager
      ?.getAllSkills()
      .filter((skill) => skill.name.startsWith(partialArg))
      .map((skill) => skill.name) ?? [];
  const registry = getSharedFabricRegistry(context);
  const sharedSkills = await registry.completeSkillNames(partialArg);

  return [...new Set([...loadedSkills, ...sharedSkills])].slice(0, 20);
}

export const skillsCommand: SlashCommand = {
  name: 'skills',
  description:
    'Set skill automation or inspect, search, load, enable, disable, or reload Gemini CLI skills. Usage: /skills [manual | auto | full | active | search <query> | recommend <query> | use <name> [task] | disable <name> | enable <name> | reload]',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  subCommands: [
    {
      name: 'manual',
      description:
        'Turn off automatic skill loading and choose skills yourself.',
      kind: CommandKind.BUILT_IN,
      action: (context) => modeAction(context, 'manual'),
    },
    {
      name: 'auto',
      description:
        'Let Gemini-2 decide when to auto-load high-confidence skills.',
      kind: CommandKind.BUILT_IN,
      action: (context) => modeAction(context, 'auto'),
    },
    {
      name: 'full',
      description:
        'Require Gemini-2 to choose suitable skills before working on a task.',
      kind: CommandKind.BUILT_IN,
      action: (context) => modeAction(context, 'full'),
    },
    {
      name: 'list',
      description:
        'List available agent skills. Usage: /skills list [nodesc] [all]',
      kind: CommandKind.BUILT_IN,
      action: listAction,
    },
    {
      name: 'active',
      description:
        'List skills currently active in this session. Usage: /skills active',
      kind: CommandKind.BUILT_IN,
      action: activeAction,
    },
    {
      name: 'search',
      description:
        'Search the shared-fabric skill catalog. Usage: /skills search <query>',
      kind: CommandKind.BUILT_IN,
      action: searchAction,
    },
    {
      name: 'recommend',
      description:
        'Route a request to recommended shared-fabric skills. Usage: /skills recommend <query>',
      kind: CommandKind.BUILT_IN,
      action: recommendAction,
    },
    {
      name: 'use',
      description:
        'Load a shared-fabric skill into this session and activate it. Usage: /skills use <name> [task prompt]',
      kind: CommandKind.BUILT_IN,
      action: useAction,
      completion: useCompletion,
    },
    {
      name: 'link',
      description:
        'Link an agent skill from a local path. Usage: /skills link <path> [--scope user|workspace]',
      kind: CommandKind.BUILT_IN,
      action: linkAction,
    },
    {
      name: 'disable',
      description: 'Disable a skill by name. Usage: /skills disable <name>',
      kind: CommandKind.BUILT_IN,
      action: disableAction,
      completion: disableCompletion,
    },
    {
      name: 'enable',
      description:
        'Enable a disabled skill by name. Usage: /skills enable <name>',
      kind: CommandKind.BUILT_IN,
      action: enableAction,
      completion: enableCompletion,
    },
    {
      name: 'reload',
      altNames: ['refresh'],
      description:
        'Reload the list of discovered skills. Usage: /skills reload',
      kind: CommandKind.BUILT_IN,
      action: reloadAction,
    },
  ],
  action: async (context, args) => {
    const trimmedArgs = args.trim();
    if (isSkillsMode(trimmedArgs)) {
      return modeAction(context, trimmedArgs);
    }
    if (trimmedArgs) {
      const parsed = parseSlashCommand(
        `/${trimmedArgs}`,
        skillsCommand.subCommands!,
      );
      if (parsed.commandToExecute?.action) {
        return parsed.commandToExecute.action(context, parsed.args);
      }
    }
    return statusAction(context);
  },
};
