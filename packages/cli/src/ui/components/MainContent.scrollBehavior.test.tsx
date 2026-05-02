/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { MainContent } from './MainContent.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Box, Text } from 'ink';
import type { JSX } from 'react';
import { act } from 'react';
import { appEvents, AppEvent } from '../../utils/events.js';
import type { UIState } from '../contexts/UIStateContext.js';

const { mockScrollableListState, mockScrollableListScrollToEnd } = vi.hoisted(
  () => ({
    mockScrollableListState: {
      scrollTop: 0,
      scrollHeight: 0,
      innerHeight: 0,
    },
    mockScrollableListScrollToEnd: vi.fn(),
  }),
);

vi.mock('../contexts/SettingsContext.js', async () => {
  const actual = await vi.importActual('../contexts/SettingsContext.js');
  return {
    ...actual,
    useSettings: () => ({
      merged: {
        ui: {
          inlineThinkingMode: 'off',
        },
      },
    }),
  };
});

vi.mock('../contexts/AppContext.js', async () => {
  const actual = await vi.importActual('../contexts/AppContext.js');
  return {
    ...actual,
    useAppContext: () => ({
      version: '1.0.0',
    }),
  };
});

vi.mock('../hooks/useAlternateBuffer.js', () => ({
  useAlternateBuffer: () => false,
}));

vi.mock('../hooks/useConfirmingTool.js', () => ({
  useConfirmingTool: () => null,
}));

vi.mock('./AppHeader.js', () => ({
  AppHeader: () => <Text>Header</Text>,
}));

vi.mock('./shared/ScrollableList.js', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  const { forwardRef, useImperativeHandle } = React;

  const MockScrollableList = forwardRef(
    (
      {
        data,
        renderItem,
      }: {
        data: unknown[];
        renderItem: (props: { item: unknown }) => JSX.Element;
      },
      ref,
    ) => {
      useImperativeHandle(ref, () => ({
        scrollBy: vi.fn(),
        scrollTo: vi.fn(),
        scrollToEnd: mockScrollableListScrollToEnd,
        scrollToIndex: vi.fn(),
        scrollToItem: vi.fn(),
        getScrollIndex: vi.fn(() => 0),
        getScrollState: vi.fn(() => ({ ...mockScrollableListState })),
      }));

      return (
        <Box flexDirection="column">
          {data.map((item: unknown, index: number) => (
            <Box key={index}>{renderItem({ item })}</Box>
          ))}
        </Box>
      );
    },
  );
  MockScrollableList.displayName = 'MockScrollableList';

  return {
    ScrollableList: MockScrollableList,
    SCROLL_TO_ITEM_END: 0,
  };
});

describe('MainContent scroll behavior', () => {
  const uiState = {
    history: [
      { id: 1, type: 'user', text: 'Hello' },
      { id: 2, type: 'gemini', text: 'Hi there' },
    ],
    pendingHistoryItems: [],
    mainAreaWidth: 80,
    staticAreaMaxItemHeight: 20,
    availableTerminalHeight: 24,
    slashCommands: [],
    constrainHeight: false,
    thought: null,
    isEditorDialogOpen: false,
    activePtyId: undefined,
    embeddedShellFocused: false,
    historyRemountKey: 0,
    cleanUiDetailsVisible: true,
    bannerData: { defaultText: '', warningText: '' },
    bannerVisible: false,
    copyModeEnabled: false,
    terminalWidth: 100,
  } as Partial<UIState>;

  beforeEach(() => {
    mockScrollableListScrollToEnd.mockReset();
    mockScrollableListState.scrollTop = 0;
    mockScrollableListState.scrollHeight = 0;
    mockScrollableListState.innerHeight = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    appEvents.removeAllListeners(AppEvent.ScrollToBottom);
  });

  it('does not force-follow when the user has scrolled up', async () => {
    mockScrollableListState.scrollTop = 10;
    mockScrollableListState.scrollHeight = 50;
    mockScrollableListState.innerHeight = 20;

    const { lastFrame } = await renderWithProviders(<MainContent />, {
      uiState,
    });
    await waitFor(() => expect(lastFrame()).toContain('Header'));

    await act(async () => {
      appEvents.emit(AppEvent.ScrollToBottom);
    });

    expect(mockScrollableListScrollToEnd).not.toHaveBeenCalled();
  });
});
