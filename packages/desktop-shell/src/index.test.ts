/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isAllowedDesktopShellOrigin, parseClientCommand } from './index.js';

describe('desktop-shell command parsing', () => {
  it('accepts valid loop_run payloads', () => {
    expect(
      parseClientCommand({
        type: 'loop_run',
        goal: 'Ship the feature',
        maxIterations: 4,
      }),
    ).toEqual({
      type: 'loop_run',
      goal: 'Ship the feature',
      maxIterations: 4,
    });
  });

  it('rejects malformed payloads', () => {
    expect(parseClientCommand({ type: 'set_model', model: 'bad' })).toBeNull();
    expect(parseClientCommand({ nope: true })).toBeNull();
  });
});

describe('desktop-shell origin policy', () => {
  it('allows localhost origins for the active port', () => {
    expect(isAllowedDesktopShellOrigin('http://127.0.0.1:43137', 43137)).toBe(
      true,
    );
    expect(isAllowedDesktopShellOrigin('http://localhost:43137', 43137)).toBe(
      true,
    );
  });

  it('rejects foreign origins and mismatched ports', () => {
    expect(isAllowedDesktopShellOrigin('https://example.com', 43137)).toBe(
      false,
    );
    expect(isAllowedDesktopShellOrigin('http://127.0.0.1:43138', 43137)).toBe(
      false,
    );
  });

  it('permits originless local clients', () => {
    expect(isAllowedDesktopShellOrigin(undefined, 43137)).toBe(true);
  });
});
