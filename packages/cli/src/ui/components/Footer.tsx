/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import {
  shortenPath,
  tildeifyPath,
  getDisplayString,
  checkExhaustive,
  AuthType,
  UserAccountManager,
} from '@google/gemini-cli-core';
import { ConsoleSummaryDisplay } from './ConsoleSummaryDisplay.js';
import process from 'node:process';
import { MemoryUsageDisplay } from './MemoryUsageDisplay.js';
import { ContextUsageDisplay } from './ContextUsageDisplay.js';
import { QuotaDisplay } from './QuotaDisplay.js';
import { DebugProfiler } from './DebugProfiler.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useQuotaState } from '../contexts/QuotaContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { useVimMode } from '../contexts/VimModeContext.js';
import { useInputState } from '../contexts/InputContext.js';
import {
  ALL_ITEMS,
  type FooterItemId,
  deriveItemsFromLegacySettings,
} from '../../config/footerItems.js';
import { isDevelopment } from '../../utils/installationInfo.js';
import {
  LoopRuntimeService,
  type LoopRuntimeSnapshot,
} from '../../services/loopRuntimeService.js';
import {
  AutomationStrategyService,
  DEFAULT_AUTOMATION_STRATEGY,
  type AgentAutomationMode,
  type LoopAutomationMode,
  type SkillAutomationMode,
} from '../../services/automationStrategyService.js';
import type { InactivityStatus } from '../hooks/useShellInactivityStatus.js';

interface CwdIndicatorProps {
  targetDir: string;
  maxWidth: number;
  debugMode?: boolean;
  debugMessage?: string;
  color?: string;
}

const CwdIndicator: React.FC<CwdIndicatorProps> = ({
  targetDir,
  maxWidth,
  debugMode,
  debugMessage,
  color = theme.text.primary,
}) => {
  const debugSuffix = debugMode ? ' ' + (debugMessage || '--debug') : '';
  const availableForPath = Math.max(10, maxWidth - debugSuffix.length);
  const displayPath = shortenPath(tildeifyPath(targetDir), availableForPath);

  return (
    <Text color={color}>
      {displayPath}
      {debugMode && <Text color={theme.status.error}>{debugSuffix}</Text>}
    </Text>
  );
};

interface SandboxIndicatorProps {
  isTrustedFolder: boolean | undefined;
}

const SandboxIndicator: React.FC<SandboxIndicatorProps> = ({
  isTrustedFolder,
}) => {
  const config = useConfig();
  const sandboxEnabled = config.getSandboxEnabled();
  if (isTrustedFolder === false) {
    return <Text color={theme.status.warning}>untrusted</Text>;
  }

  const sandbox = process.env['SANDBOX'];
  if (sandbox) {
    return <Text color={theme.status.warning}>current process</Text>;
  }

  if (sandboxEnabled) {
    return <Text color={theme.status.warning}>all tools</Text>;
  }

  return <Text color={theme.status.error}>no sandbox</Text>;
};

const CorgiIndicator: React.FC = () => (
  <Text>
    <Text color={theme.status.error}>▼</Text>
    <Text color={theme.text.primary}>(´</Text>
    <Text color={theme.status.error}>ᴥ</Text>
    <Text color={theme.text.primary}>`)</Text>
    <Text color={theme.status.error}>▼</Text>
  </Text>
);

export interface FooterRowItem {
  key: string;
  header: string;
  element: React.ReactNode;
  flexGrow?: number;
  flexShrink?: number;
  isFocused?: boolean;
  alignItems?: 'flex-start' | 'center' | 'flex-end';
}

const COLUMN_GAP = 3;

export const FooterRow: React.FC<{
  items: FooterRowItem[];
  showLabels: boolean;
}> = ({ items, showLabels }) => {
  const elements: React.ReactNode[] = [];

  items.forEach((item, idx) => {
    if (idx > 0) {
      elements.push(
        <Box
          key={`sep-${item.key}`}
          flexGrow={1}
          flexShrink={1}
          minWidth={showLabels ? COLUMN_GAP : 3}
          justifyContent="center"
          alignItems="center"
        >
          {!showLabels && <Text color={theme.ui.comment}> · </Text>}
        </Box>,
      );
    }

    elements.push(
      <Box
        key={item.key}
        flexDirection="column"
        flexGrow={item.flexGrow ?? 0}
        flexShrink={item.flexShrink ?? 1}
        alignItems={item.alignItems}
        backgroundColor={item.isFocused ? theme.background.focus : undefined}
      >
        {showLabels && (
          <Box height={1}>
            <Text
              color={item.isFocused ? theme.text.primary : theme.ui.comment}
            >
              {item.header}
            </Text>
          </Box>
        )}
        <Box height={1}>{item.element}</Box>
      </Box>,
    );
  });

  return (
    <Box flexDirection="row" flexWrap="nowrap" width="100%">
      {elements}
    </Box>
  );
};

function isFooterItemId(id: string): id is FooterItemId {
  return ALL_ITEMS.some((i) => i.id === id);
}

interface FooterColumn {
  id: string;
  header: string;
  element: (maxWidth: number) => React.ReactNode;
  width: number;
  isHighPriority: boolean;
}

const IDLE_LOOP_SNAPSHOT: LoopRuntimeSnapshot = {
  statePath: '',
  exists: false,
  status: 'idle',
  iteration: 0,
};

export function formatLoopStatus(
  snapshot: LoopRuntimeSnapshot,
  mode: LoopAutomationMode,
): string {
  switch (snapshot.status) {
    case 'idle':
      return mode;
    case 'active':
      return `${mode} ${snapshot.iteration}/${snapshot.maxIterations ?? '?'}`;
    case 'paused':
      return `${mode} paused`;
    case 'completed':
      return `${mode} done`;
    default:
      return mode;
  }
}

export function formatSkillStatus(
  mode: SkillAutomationMode,
  activeSkillCount: number,
  totalSkillCount: number,
): string {
  if (activeSkillCount <= 0 || totalSkillCount <= 0) {
    return mode;
  }
  return `${mode} ${activeSkillCount} on`;
}

export function formatAgentStatus(
  mode: AgentAutomationMode,
  totalAgentCount: number,
): string {
  if (totalAgentCount <= 0) {
    return mode;
  }
  return `${mode} ${totalAgentCount} ready`;
}

export function formatShellStatus(
  activePtyId: number | undefined,
  inactivityStatus: InactivityStatus,
): string {
  if (!activePtyId) {
    return 'idle';
  }

  switch (inactivityStatus) {
    case 'stalled':
      return 'stalled';
    case 'action_required':
      return 'needs focus';
    case 'silent_working':
      return 'busy';
    case 'none':
    default:
      return 'running';
  }
}

export const Footer: React.FC = () => {
  const uiState = useUIState();
  const quotaState = useQuotaState();
  const { copyModeEnabled } = useInputState();
  const config = useConfig();
  const settings = useSettings();
  const { vimEnabled, vimMode } = useVimMode();

  const authType = config.getContentGeneratorConfig()?.authType;
  const [email, setEmail] = useState<string | undefined>();
  const [loopSnapshot, setLoopSnapshot] =
    useState<LoopRuntimeSnapshot>(IDLE_LOOP_SNAPSHOT);
  const [automationModes, setAutomationModes] = useState({
    loopMode: DEFAULT_AUTOMATION_STRATEGY.loopMode,
    skillsMode: DEFAULT_AUTOMATION_STRATEGY.skillsMode,
    agentsMode: DEFAULT_AUTOMATION_STRATEGY.agentsMode,
  });

  const {
    model,
    targetDir,
    debugMode,
    branchName,
    debugMessage,
    corgiMode,
    errorCount,
    showErrorDetails,
    promptTokenCount,
    isTrustedFolder,
    terminalWidth,
  } = {
    model: uiState.currentModel,
    targetDir: config.getTargetDir(),
    debugMode: config.getDebugMode(),
    branchName: uiState.branchName,
    debugMessage: uiState.debugMessage,
    corgiMode: uiState.corgiMode,
    errorCount: uiState.errorCount,
    showErrorDetails: uiState.showErrorDetails,
    promptTokenCount: uiState.sessionStats.lastPromptTokenCount,
    isTrustedFolder: uiState.isTrustedFolder,
    terminalWidth: uiState.terminalWidth,
  };

  useEffect(() => {
    if (authType) {
      const userAccountManager = new UserAccountManager();
      setEmail(userAccountManager.getCachedGoogleAccount() ?? undefined);
    } else {
      setEmail(undefined);
    }
  }, [authType]);

  useEffect(() => {
    if (process.env['VITEST']) {
      return;
    }

    let cancelled = false;

    const refreshLoopSnapshot = async () => {
      try {
        const loopRuntime = new LoopRuntimeService(
          config,
          config.getTargetDir(),
        );
        const strategyService = new AutomationStrategyService(config);
        const [snapshot, strategy] = await Promise.all([
          loopRuntime.getSnapshot(),
          strategyService.getState(),
        ]);
        if (!cancelled) {
          setLoopSnapshot(snapshot);
          setAutomationModes(strategy);
        }
      } catch {
        if (!cancelled) {
          setLoopSnapshot(IDLE_LOOP_SNAPSHOT);
          setAutomationModes({
            loopMode: DEFAULT_AUTOMATION_STRATEGY.loopMode,
            skillsMode: DEFAULT_AUTOMATION_STRATEGY.skillsMode,
            agentsMode: DEFAULT_AUTOMATION_STRATEGY.agentsMode,
          });
        }
      }
    };

    void refreshLoopSnapshot();
    const interval = setInterval(() => {
      void refreshLoopSnapshot();
    }, 1500);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [config, targetDir]);

  const quotaStats = quotaState.stats;
  const skillManager = config.getSkillManager?.();
  const displayableSkillCount = skillManager
    ? skillManager.getDisplayableSkills().length
    : 0;
  const activeSkillCount = skillManager
    ? skillManager
        .getAllSkills()
        .filter((skill) => skillManager.isSkillActive(skill.name)).length
    : 0;
  const agentRegistry = config.getAgentRegistry?.();
  const agentCount = agentRegistry
    ? agentRegistry.getAllDefinitions().length
    : 0;

  const isFullErrorVerbosity = settings.merged.ui.errorVerbosity === 'full';
  const showErrorSummary =
    !showErrorDetails &&
    errorCount > 0 &&
    (isFullErrorVerbosity || debugMode || isDevelopment);
  const displayVimMode = vimEnabled ? vimMode : undefined;

  const items =
    settings.merged.ui.footer.items ??
    deriveItemsFromLegacySettings(settings.merged);
  const showLabels = settings.merged.ui.footer.showLabels !== false;
  const itemColor = showLabels ? theme.text.primary : theme.ui.comment;

  const potentialColumns: FooterColumn[] = [];

  const addCol = (
    id: string,
    header: string,
    element: (maxWidth: number) => React.ReactNode,
    dataWidth: number,
    isHighPriority = false,
  ) => {
    potentialColumns.push({
      id,
      header: showLabels ? header : '',
      element,
      width: Math.max(dataWidth, showLabels ? header.length : 0),
      isHighPriority,
    });
  };

  // 1. System Indicators (Far Left, high priority)
  if (uiState.showDebugProfiler) {
    addCol('debug', '', () => <DebugProfiler />, 45, true);
  }
  if (displayVimMode) {
    const vimStr = `[${displayVimMode}]`;
    addCol(
      'vim',
      '',
      () => <Text color={theme.text.accent}>{vimStr}</Text>,
      vimStr.length,
      true,
    );
  }

  // 2. Main Configurable Items
  for (const id of items) {
    if (!isFooterItemId(id)) continue;
    const itemConfig = ALL_ITEMS.find((i) => i.id === id);
    const header = itemConfig?.header ?? id;

    switch (id) {
      case 'workspace': {
        const fullPath = tildeifyPath(targetDir);
        const debugSuffix = debugMode ? ' ' + (debugMessage || '--debug') : '';
        addCol(
          id,
          header,
          (maxWidth) => (
            <CwdIndicator
              targetDir={targetDir}
              maxWidth={maxWidth}
              debugMode={debugMode}
              debugMessage={debugMessage}
              color={itemColor}
            />
          ),
          fullPath.length + debugSuffix.length,
        );
        break;
      }
      case 'git-branch': {
        if (branchName) {
          addCol(
            id,
            header,
            () => <Text color={itemColor}>{branchName}</Text>,
            branchName.length,
          );
        }
        break;
      }
      case 'sandbox': {
        let str = 'no sandbox';
        const sandbox = process.env['SANDBOX'];
        if (isTrustedFolder === false) str = 'untrusted';
        else if (sandbox) str = 'current process';
        else if (config.getSandboxEnabled()) str = 'all tools';

        addCol(
          id,
          header,
          () => <SandboxIndicator isTrustedFolder={isTrustedFolder} />,
          str.length,
        );
        break;
      }
      case 'model-name': {
        const str = getDisplayString(model);
        addCol(
          id,
          header,
          () => <Text color={itemColor}>{str}</Text>,
          str.length,
        );
        break;
      }
      case 'loop-status': {
        const str = formatLoopStatus(loopSnapshot, automationModes.loopMode);
        const color =
          loopSnapshot.status === 'active'
            ? theme.status.warning
            : loopSnapshot.status === 'completed'
              ? theme.status.success
              : loopSnapshot.status === 'paused'
                ? theme.status.error
                : itemColor;
        addCol(id, header, () => <Text color={color}>{str}</Text>, str.length);
        break;
      }
      case 'skill-status': {
        const str = formatSkillStatus(
          automationModes.skillsMode,
          activeSkillCount,
          displayableSkillCount,
        );
        const color =
          activeSkillCount > 0 ? theme.status.success : theme.ui.comment;
        addCol(id, header, () => <Text color={color}>{str}</Text>, str.length);
        break;
      }
      case 'agent-status': {
        const str = formatAgentStatus(automationModes.agentsMode, agentCount);
        addCol(
          id,
          header,
          () => <Text color={itemColor}>{str}</Text>,
          str.length,
        );
        break;
      }
      case 'shell-status': {
        const str = formatShellStatus(
          uiState.activePtyId,
          uiState.shellInactivityStatus,
        );
        const color =
          str === 'stalled'
            ? theme.status.error
            : str === 'needs focus'
              ? theme.status.warning
              : str === 'busy'
                ? theme.status.warning
                : str === 'running'
                  ? theme.status.success
                  : itemColor;
        addCol(id, header, () => <Text color={color}>{str}</Text>, str.length);
        break;
      }
      case 'context-used': {
        addCol(
          id,
          header,
          () => (
            <ContextUsageDisplay
              promptTokenCount={promptTokenCount}
              model={model}
              terminalWidth={terminalWidth}
            />
          ),
          10, // "100% used" is 9 chars
        );
        break;
      }
      case 'quota': {
        if (quotaStats?.remaining !== undefined && quotaStats.limit) {
          addCol(
            id,
            header,
            () => (
              <QuotaDisplay
                remaining={quotaStats.remaining}
                limit={quotaStats.limit}
                forceShow={true}
                lowercase={true}
              />
            ),
            9, // "100% used" is 9 chars
          );
        }
        break;
      }
      case 'memory-usage': {
        addCol(
          id,
          header,
          () => (
            <MemoryUsageDisplay color={itemColor} isActive={!copyModeEnabled} />
          ),
          10,
        );
        break;
      }
      case 'session-id': {
        addCol(
          id,
          header,
          () => (
            <Text color={itemColor}>
              {uiState.sessionStats.sessionId.slice(0, 8)}
            </Text>
          ),
          8,
        );
        break;
      }
      case 'auth': {
        if (!settings.merged.ui.showUserIdentity) break;
        if (!authType) break;
        const displayStr =
          authType === AuthType.LOGIN_WITH_GOOGLE
            ? (email ?? 'google')
            : authType;
        addCol(
          id,
          header,
          () => (
            <Text color={itemColor} wrap="truncate-end">
              {displayStr}
            </Text>
          ),
          displayStr.length,
        );
        break;
      }
      case 'code-changes': {
        const added = uiState.sessionStats.metrics.files.totalLinesAdded;
        const removed = uiState.sessionStats.metrics.files.totalLinesRemoved;
        if (added > 0 || removed > 0) {
          const str = `+${added} -${removed}`;
          addCol(
            id,
            header,
            () => (
              <Text>
                <Text color={theme.status.success}>+{added}</Text>{' '}
                <Text color={theme.status.error}>-{removed}</Text>
              </Text>
            ),
            str.length,
          );
        }
        break;
      }
      case 'token-count': {
        let total = 0;
        for (const m of Object.values(uiState.sessionStats.metrics.models))
          total += m.tokens.total;
        if (total > 0) {
          const formatter = new Intl.NumberFormat('en-US', {
            notation: 'compact',
            maximumFractionDigits: 1,
          });
          const formatted = formatter.format(total).toLowerCase();
          addCol(
            id,
            header,
            () => <Text color={itemColor}>{formatted} tokens</Text>,
            formatted.length + 7,
          );
        }
        break;
      }
      default:
        checkExhaustive(id);
        break;
    }
  }

  // 3. Transients
  if (corgiMode) addCol('corgi', '', () => <CorgiIndicator />, 5);
  if (showErrorSummary) {
    addCol(
      'error-count',
      '',
      () => <ConsoleSummaryDisplay errorCount={errorCount} />,
      12,
      true,
    );
  }

  // --- Width Fitting Logic ---
  const columnsToRender: FooterColumn[] = [];
  let droppedAny = false;
  let currentUsedWidth = 2; // Initial padding

  for (const col of potentialColumns) {
    const gap = columnsToRender.length > 0 ? (showLabels ? COLUMN_GAP : 3) : 0;
    const budgetWidth = col.id === 'workspace' ? 20 : col.width;

    if (
      col.isHighPriority ||
      currentUsedWidth + gap + budgetWidth <= terminalWidth - 2
    ) {
      columnsToRender.push(col);
      currentUsedWidth += gap + budgetWidth;
    } else {
      droppedAny = true;
    }
  }

  const rowItems: FooterRowItem[] = columnsToRender.map((col, index) => {
    const isWorkspace = col.id === 'workspace';
    const isLast = index === columnsToRender.length - 1;

    // Calculate exact space available for growth to prevent over-estimation truncation
    const otherItemsWidth = columnsToRender
      .filter((c) => c.id !== 'workspace')
      .reduce((sum, c) => sum + c.width, 0);
    const numItems = columnsToRender.length + (droppedAny ? 1 : 0);
    const numGaps = numItems > 1 ? numItems - 1 : 0;
    const gapsWidth = numGaps * (showLabels ? COLUMN_GAP : 3);
    const ellipsisWidth = droppedAny ? 1 : 0;

    const availableForWorkspace = Math.max(
      20,
      terminalWidth - 2 - gapsWidth - otherItemsWidth - ellipsisWidth,
    );

    const estimatedWidth = isWorkspace ? availableForWorkspace : col.width;

    return {
      key: col.id,
      header: col.header,
      element: col.element(estimatedWidth),
      flexGrow: 0,
      flexShrink: isWorkspace ? 1 : 0,
      alignItems:
        isLast && !droppedAny && index > 0 ? 'flex-end' : 'flex-start',
    };
  });

  if (droppedAny) {
    rowItems.push({
      key: 'ellipsis',
      header: '',
      element: <Text color={theme.ui.comment}>…</Text>,
      flexGrow: 0,
      flexShrink: 0,
      alignItems: 'flex-end',
    });
  }

  return (
    <Box width={terminalWidth} paddingX={1} overflow="hidden" flexWrap="nowrap">
      <FooterRow items={rowItems} showLabels={showLabels} />
    </Box>
  );
};
