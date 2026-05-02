/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';

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

interface ShellState {
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

interface ToastState {
  message: string;
  tone: 'default' | 'success' | 'warning';
}

type IncomingMessage =
  | { type: 'state'; payload: ShellState }
  | { type: 'toast'; payload: ToastState };

export default function App() {
  const [state, setState] = useState<ShellState | null>(null);
  const [composer, setComposer] = useState('');
  const [toast, setToast] = useState<ToastState | null>(null);
  const [connection, setConnection] = useState<
    'connecting' | 'open' | 'closed'
  >('connecting');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingMessagesRef = useRef<string[]>([]);
  const shouldAutoScrollRef = useRef(true);

  const flushQueuedMessages = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    for (const payload of pendingMessagesRef.current) {
      ws.send(payload);
    }
    pendingMessagesRef.current = [];
  };

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
    wsRef.current = ws;

    ws.addEventListener('open', () => {
      setConnection('open');
      pendingMessagesRef.current.unshift(JSON.stringify({ type: 'get_state' }));
      flushQueuedMessages();
    });

    ws.addEventListener('close', () => {
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      setConnection('closed');
    });

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data) as IncomingMessage;
      if (message.type === 'state') {
        setState(message.payload);
      }
      if (message.type === 'toast') {
        setToast(message.payload);
      }
    });

    return () => {
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      ws.close();
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !shouldAutoScrollRef.current) {
      return;
    }

    container.scrollTo({
      top: container.scrollHeight,
      behavior: 'smooth',
    });
  }, [state?.messages.length, state?.runtime.busy]);

  const send = (payload: object) => {
    const serialized = JSON.stringify(payload);
    const ws = wsRef.current;
    if (!ws || ws.readyState === WebSocket.CONNECTING) {
      pendingMessagesRef.current.push(serialized);
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(serialized);
      return;
    }

    pendingMessagesRef.current.push(serialized);
    setConnection('closed');
  };

  const submitPrompt = () => {
    const prompt = composer.trim();
    if (!prompt) return;
    send({ type: 'submit_prompt', prompt });
    setComposer('');
  };

  const startLoop = (autoRun: boolean) => {
    const goal = composer.trim();
    if (!goal) return;
    send({
      type: autoRun ? 'loop_run' : 'loop_start',
      goal,
      maxIterations: 8,
    });
    setComposer('');
  };

  const palette = useMemo(
    () => ({
      paper: '#f5efe4',
      panel: '#fbf8f1',
      panelStrong: '#fffdf9',
      border: '#d8cbbb',
      text: '#1f2620',
      textSoft: '#5f695f',
      accent: '#1d7a5f',
      accentSoft: '#d9efe7',
      warm: '#ef8b55',
      warmSoft: '#f9e3d3',
      shadow: '0 18px 50px rgba(64, 52, 33, 0.12)',
      shellBg: '#1e241f',
      shellText: '#e5f0e7',
      muted: '#eef0ea',
    }),
    [],
  );

  if (!state) {
    return (
      <div
        style={{
          height: '100%',
          display: 'grid',
          placeItems: 'center',
          background:
            'radial-gradient(circle at top left, #f6d8c5 0%, #efe9dd 45%, #e8efe8 100%)',
          color: '#223128',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <div
            style={{ fontSize: 36, fontWeight: 700, letterSpacing: '-0.04em' }}
          >
            Gemini-2 Studio
          </div>
          <div style={{ marginTop: 12, opacity: 0.72 }}>
            Connecting to the local desktop shell...
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        height: '100%',
        background:
          'radial-gradient(circle at top left, #f6d8c5 0%, #efe9dd 45%, #e8efe8 100%)',
        color: palette.text,
        padding: 18,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          height: '100%',
          display: 'grid',
          gridTemplateColumns: '1.9fr 1fr',
          gap: 18,
        }}
      >
        <section
          style={{
            display: 'grid',
            gridTemplateRows: 'auto auto 1fr auto',
            gap: 14,
            minHeight: 0,
          }}
        >
          <header
            style={{
              border: `1px solid ${palette.border}`,
              background: 'rgba(255,255,255,0.6)',
              backdropFilter: 'blur(12px)',
              borderRadius: 24,
              padding: '18px 22px',
              boxShadow: palette.shadow,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: 30,
                    fontWeight: 750,
                    letterSpacing: '-0.05em',
                  }}
                >
                  Gemini-2 Studio
                </div>
                <div style={{ color: palette.textSoft, marginTop: 6 }}>
                  Chat-first shell for loop, model, effort, skills, and runtime.
                </div>
              </div>
              <div
                style={{
                  padding: '10px 14px',
                  borderRadius: 999,
                  background:
                    connection === 'open'
                      ? palette.accentSoft
                      : palette.warmSoft,
                  color: connection === 'open' ? palette.accent : palette.warm,
                  fontWeight: 700,
                }}
              >
                {connection === 'open' ? 'Live' : connection}
              </div>
            </div>
          </header>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
              gap: 12,
            }}
          >
            <ControlCard
              title="Model"
              subtitle="Switch the runtime lane."
              palette={palette}
            >
              <Segmented
                value={state.controls.model}
                options={['auto', 'flash', 'pro']}
                onSelect={(model) => send({ type: 'set_model', model })}
                palette={palette}
              />
            </ControlCard>
            <ControlCard
              title="Effort"
              subtitle="Choose how deliberate the assistant should be."
              palette={palette}
            >
              <Segmented
                value={state.controls.effort}
                options={['low', 'medium', 'high']}
                onSelect={(effort) => send({ type: 'set_effort', effort })}
                palette={palette}
              />
            </ControlCard>
            <ControlCard
              title="Loop"
              subtitle={
                state.loop.autoRun
                  ? `Autorun on · ${state.loop.iteration}/${state.loop.maxIterations}`
                  : state.loop.status === 'idle'
                    ? 'Ready for a long-horizon goal.'
                    : `${state.loop.status} · ${state.loop.iteration}/${state.loop.maxIterations}`
              }
              palette={palette}
            >
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <ActionButton
                  label="Run Loop"
                  onClick={() => startLoop(true)}
                  palette={palette}
                  tone="accent"
                />
                <ActionButton
                  label="Start Once"
                  onClick={() => startLoop(false)}
                  palette={palette}
                />
                <ActionButton
                  label="Stop"
                  onClick={() => send({ type: 'loop_stop' })}
                  palette={palette}
                />
              </div>
            </ControlCard>
          </div>

          <div
            ref={scrollRef}
            onScroll={() => {
              const container = scrollRef.current;
              if (!container) {
                return;
              }
              const remaining =
                container.scrollHeight -
                (container.scrollTop + container.clientHeight);
              shouldAutoScrollRef.current = remaining <= 48;
            }}
            style={{
              minHeight: 0,
              overflow: 'auto',
              borderRadius: 28,
              border: `1px solid ${palette.border}`,
              background: 'rgba(255,255,255,0.72)',
              boxShadow: palette.shadow,
              padding: 18,
            }}
          >
            <div style={{ display: 'grid', gap: 14 }}>
              {state.messages.map((message) => (
                <div
                  key={message.id}
                  style={{
                    justifySelf: message.role === 'user' ? 'end' : 'stretch',
                    maxWidth: message.role === 'user' ? '76%' : '100%',
                    borderRadius: 22,
                    padding: '14px 16px',
                    background:
                      message.role === 'user'
                        ? palette.accent
                        : message.role === 'assistant'
                          ? palette.panelStrong
                          : palette.warmSoft,
                    color: message.role === 'user' ? '#f8fff9' : palette.text,
                    border:
                      message.role === 'assistant'
                        ? `1px solid ${palette.border}`
                        : 'none',
                    whiteSpace: 'pre-wrap',
                    lineHeight: 1.55,
                  }}
                >
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      opacity: 0.68,
                      marginBottom: 8,
                    }}
                  >
                    {message.role}
                  </div>
                  <div>
                    {message.text || (message.pending ? 'Thinking...' : '')}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <footer
            style={{
              border: `1px solid ${palette.border}`,
              background: 'rgba(255,255,255,0.68)',
              borderRadius: 24,
              boxShadow: palette.shadow,
              padding: 16,
              display: 'grid',
              gap: 12,
            }}
          >
            <textarea
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              placeholder="Ask normally, or type a long-horizon goal and hit Run Loop."
              style={{
                width: '100%',
                minHeight: 92,
                resize: 'none',
                borderRadius: 18,
                border: `1px solid ${palette.border}`,
                padding: 16,
                boxSizing: 'border-box',
                fontSize: 15,
                lineHeight: 1.5,
                background: palette.panelStrong,
                color: palette.text,
                outline: 'none',
              }}
            />
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ color: palette.textSoft, fontSize: 13 }}>
                Workspace: {state.workspaceRoot}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <ActionButton
                  label={state.runtime.busy ? 'Thinking…' : 'Send'}
                  onClick={submitPrompt}
                  disabled={state.runtime.busy}
                  palette={palette}
                  tone="accent"
                />
                <ActionButton
                  label="Run Loop"
                  onClick={() => startLoop(true)}
                  disabled={state.runtime.busy}
                  palette={palette}
                  tone="warm"
                />
              </div>
            </div>
          </footer>
        </section>

        <aside
          style={{
            display: 'grid',
            gridTemplateRows: 'auto auto auto 1fr',
            gap: 14,
            minHeight: 0,
          }}
        >
          <Panel title="Runtime Snapshot" palette={palette}>
            <KeyValue
              label="Session"
              value={state.sessionId || 'not started'}
            />
            <KeyValue label="Turns" value={String(state.runtime.turnCount)} />
            <KeyValue
              label="Busy"
              value={state.runtime.busy ? 'responding' : 'idle'}
            />
            <KeyValue
              label="Updated"
              value={state.runtime.lastUpdatedAt || 'not yet'}
            />
          </Panel>

          <Panel title="Skills & Agents" palette={palette}>
            <ChipRow
              title="Skills"
              empty="No skills observed yet."
              values={state.runtime.activeSkills}
              palette={palette}
            />
            <ChipRow
              title="Agents"
              empty="No agents invoked yet."
              values={state.runtime.activeAgents}
              palette={palette}
            />
            <ChipRow
              title="Tools"
              empty="No tools called yet."
              values={state.runtime.recentTools}
              palette={palette}
            />
          </Panel>

          <Panel title="Loop Status" palette={palette}>
            <KeyValue
              label="Mode"
              value={state.loop.autoRun ? 'autorun' : state.loop.status}
            />
            <KeyValue
              label="Goal"
              value={state.loop.goal || 'No active loop'}
            />
            <KeyValue
              label="Progress"
              value={`${state.loop.iteration}/${state.loop.maxIterations}`}
            />
            <KeyValue
              label="Checkpoint"
              value={
                state.loop.lastCheckpoint || state.loop.stopReason || 'None yet'
              }
            />
          </Panel>

          <Panel title="Runtime Tape" palette={palette} scroll>
            <div
              style={{
                display: 'grid',
                gap: 10,
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                fontSize: 12.5,
              }}
            >
              {state.activity.length === 0 ? (
                <div style={{ color: palette.textSoft }}>
                  Tool, loop, skill, and agent activity will appear here.
                </div>
              ) : (
                state.activity.map((item) => (
                  <div
                    key={item.id}
                    style={{
                      borderRadius: 16,
                      padding: '10px 12px',
                      background:
                        item.tone === 'warning'
                          ? '#fff0e8'
                          : item.tone === 'success'
                            ? '#e9f7f0'
                            : palette.muted,
                      color: palette.text,
                    }}
                  >
                    <div style={{ fontWeight: 700 }}>{item.title}</div>
                    {item.detail ? (
                      <div style={{ marginTop: 6, color: palette.textSoft }}>
                        {item.detail}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </Panel>
        </aside>
      </div>

      {toast ? (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            right: 24,
            padding: '12px 16px',
            borderRadius: 18,
            background:
              toast.tone === 'warning'
                ? palette.warmSoft
                : toast.tone === 'success'
                  ? palette.accentSoft
                  : palette.panelStrong,
            border: `1px solid ${palette.border}`,
            boxShadow: palette.shadow,
            color: palette.text,
            fontWeight: 600,
          }}
        >
          {toast.message}
        </div>
      ) : null}
    </div>
  );
}

function Panel({
  title,
  palette,
  children,
  scroll = false,
}: React.PropsWithChildren<{
  title: string;
  palette: Record<string, string>;
  scroll?: boolean;
}>) {
  return (
    <section
      style={{
        border: `1px solid ${palette.border}`,
        background: 'rgba(255,255,255,0.72)',
        borderRadius: 24,
        boxShadow: palette.shadow,
        padding: 16,
        minHeight: 0,
        overflow: scroll ? 'auto' : 'visible',
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 800,
          letterSpacing: '0.09em',
          textTransform: 'uppercase',
          color: palette.textSoft,
          marginBottom: 12,
        }}
      >
        {title}
      </div>
      {children}
    </section>
  );
}

function ControlCard({
  title,
  subtitle,
  palette,
  children,
}: React.PropsWithChildren<{
  title: string;
  subtitle: string;
  palette: Record<string, string>;
}>) {
  return (
    <div
      style={{
        border: `1px solid ${palette.border}`,
        background: 'rgba(255,255,255,0.72)',
        borderRadius: 22,
        boxShadow: palette.shadow,
        padding: 16,
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 750 }}>{title}</div>
      <div
        style={{
          color: palette.textSoft,
          margin: '4px 0 12px 0',
          fontSize: 13,
        }}
      >
        {subtitle}
      </div>
      {children}
    </div>
  );
}

function Segmented({
  value,
  options,
  onSelect,
  palette,
}: {
  value: string;
  options: string[];
  onSelect: (value: string) => void;
  palette: Record<string, string>;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`,
        gap: 6,
      }}
    >
      {options.map((option) => {
        const active = option === value;
        return (
          <button
            key={option}
            onClick={() => onSelect(option)}
            style={{
              border: active ? 'none' : `1px solid ${palette.border}`,
              background: active ? palette.accent : palette.panelStrong,
              color: active ? '#f8fff9' : palette.text,
              padding: '10px 0',
              borderRadius: 14,
              cursor: 'pointer',
              fontWeight: 700,
              textTransform: 'capitalize',
            }}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  palette,
  tone = 'default',
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  palette: Record<string, string>;
  tone?: 'default' | 'accent' | 'warm';
  disabled?: boolean;
}) {
  const backgrounds = {
    default: palette.panelStrong,
    accent: palette.accent,
    warm: palette.warm,
  };
  const colors = {
    default: palette.text,
    accent: '#f8fff9',
    warm: '#fffaf5',
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        border: tone === 'default' ? `1px solid ${palette.border}` : 'none',
        background: disabled ? '#d7d9d1' : backgrounds[tone],
        color: disabled ? '#80887b' : colors[tone],
        padding: '10px 14px',
        borderRadius: 14,
        fontWeight: 750,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'grid', gap: 3, marginBottom: 10 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          opacity: 0.58,
        }}
      >
        {label}
      </div>
      <div style={{ lineHeight: 1.45 }}>{value}</div>
    </div>
  );
}

function ChipRow({
  title,
  empty,
  values,
  palette,
}: {
  title: string;
  empty: string;
  values: string[];
  palette: Record<string, string>;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          opacity: 0.58,
          marginBottom: 7,
        }}
      >
        {title}
      </div>
      {values.length === 0 ? (
        <div style={{ color: palette.textSoft, fontSize: 13 }}>{empty}</div>
      ) : (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {values.map((value) => (
            <div
              key={value}
              style={{
                padding: '7px 10px',
                borderRadius: 999,
                background: palette.accentSoft,
                color: palette.accent,
                fontWeight: 700,
                fontSize: 13,
              }}
            >
              {value}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
