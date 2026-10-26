import { describe, expect, it } from 'vitest';
import { CLI_REGISTRY } from '../cli/registry.js';
import {
  AGENT_HISTORY_PROVIDERS,
  type AgentHistoryProvider,
  claudeProjectDirName,
  codexRolloutMeta,
  type FreebuffChatMeta,
  freebuffProjectDirName,
  HISTORY_UNSUPPORTED_CLIS,
  type OpencodeSessionRow,
  parseFreebuffMeta,
  promptPreview,
  sameFolder,
  summarizeClaudeTranscript,
  summarizeClineSession,
  summarizeCodexRollout,
  summarizeContinueSession,
  summarizeCursorSession,
  summarizeFreebuffChat,
  summarizeGeminiChat,
  summarizeGrokChat,
  summarizeOpencodeSession,
} from './sessionHistory.js';

const line = (value: unknown): string => JSON.stringify(value);

describe('claude project folder names', () => {
  it('turns every non alphanumeric character into a dash', () => {
    expect(claudeProjectDirName('E:\\Runova')).toBe('E--Runova');
    expect(claudeProjectDirName('/home/me/my_app.v2/')).toBe('-home-me-my-app-v2');
  });

  it('compares folders loosely', () => {
    expect(sameFolder('e:\\Runova\\', 'E:/runova', true)).toBe(true);
    expect(sameFolder('/a/B', '/a/b', false)).toBe(false);
  });
});

describe('prompt previews', () => {
  it('drops wrappers that the user did not type', () => {
    expect(promptPreview('<command-name>/clear</command-name>')).toBeNull();
    expect(promptPreview('[Request interrupted by user]')).toBeNull();
    expect(promptPreview('   ')).toBeNull();
  });

  it('cleans reminders, images and whitespace', () => {
    expect(
      promptPreview('[Image #1] fix\n\nthe <system-reminder>ignore</system-reminder> header'),
    ).toBe('fix the header');
  });

  it('shortens long prompts', () => {
    const preview = promptPreview('x'.repeat(500)) ?? '';
    expect(preview.length).toBe(240);
    expect(preview.endsWith('…')).toBe(true);
  });
});

describe('claude transcripts', () => {
  const head = [
    line({ type: 'last-prompt', sessionId: 's' }),
    line({
      type: 'user',
      cwd: 'E:\\App',
      gitBranch: 'main',
      entrypoint: 'cli',
      timestamp: '2026-09-01T10:00:00.000Z',
      message: { role: 'user', content: '<command-name>/model</command-name>' },
    }),
    line({
      type: 'user',
      cwd: 'E:\\App',
      timestamp: '2026-09-01T10:00:05.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'Add a dark mode' }] },
    }),
    line({
      type: 'assistant',
      effort: 'high',
      perTurnEffort: null,
      message: { model: 'claude-opus-5' },
    }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
    '{"type":"user","message":{"content":"cut off mid',
  ];

  it('reads the prompt, folder, branch and model', () => {
    const summary = summarizeClaudeTranscript('s', head, []);
    expect(summary).toMatchObject({
      id: 's',
      title: null,
      firstPrompt: 'Add a dark mode',
      lastPrompt: null,
      cwd: 'E:\\App',
      gitBranch: 'main',
      model: 'claude-opus-5',
      effort: 'high',
      startedAt: Date.parse('2026-09-01T10:00:00.000Z'),
      background: false,
    });
  });

  it('prefers a custom title, then the generated one, and takes the latest model', () => {
    const tail = [
      'partial line"}',
      line({ type: 'ai-title', aiTitle: 'Dark mode' }),
      line({
        type: 'assistant',
        gitBranch: 'feat/dark',
        effort: 'xhigh',
        message: { model: 'claude-sonnet-5' },
      }),
      line({ type: 'last-prompt', lastPrompt: 'Now ship it' }),
    ];
    const summary = summarizeClaudeTranscript('s', head, tail);
    expect(summary?.title).toBe('Dark mode');
    expect(summary?.model).toBe('claude-sonnet-5');
    expect(summary?.effort).toBe('xhigh');
    expect(summary?.gitBranch).toBe('feat/dark');
    expect(summary?.lastPrompt).toBe('Now ship it');

    const renamed = summarizeClaudeTranscript('s', head, [
      ...tail,
      line({ type: 'custom-title', customTitle: 'Theme work' }),
    ]);
    expect(renamed?.title).toBe('Theme work');
  });

  it('marks headless runs and skips empty files', () => {
    const headless = summarizeClaudeTranscript(
      's',
      [line({ type: 'user', entrypoint: 'sdk-cli', message: { content: 'Pick a tag' } })],
      [],
    );
    expect(headless?.background).toBe(true);
    expect(
      summarizeClaudeTranscript('s', [line({ type: 'file-history-snapshot' })], []),
    ).toBeNull();
  });
});

describe('codex rollouts', () => {
  const meta = line({
    type: 'session_meta',
    timestamp: '2026-08-17T22:14:26.647Z',
    payload: {
      id: 'abc',
      timestamp: '2026-08-17T22:14:26.483Z',
      cwd: 'E:\\App',
      originator: 'codex_cli_rs',
      git: { branch: 'main' },
    },
  });

  it('reads the meta line', () => {
    expect(codexRolloutMeta(meta)).toEqual({ id: 'abc', cwd: 'E:\\App', background: false });
    expect(codexRolloutMeta(line({ type: 'event_msg' }))).toBeNull();
  });

  it('summarizes prompts and model', () => {
    const summary = summarizeCodexRollout(
      [
        meta,
        line({ type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'medium' } }),
        line({ type: 'event_msg', payload: { type: 'user_message', message: 'Fix the tests' } }),
      ],
      [line({ type: 'event_msg', payload: { type: 'user_message', message: 'And lint' } })],
    );
    expect(summary).toMatchObject({
      id: 'abc',
      firstPrompt: 'Fix the tests',
      lastPrompt: 'And lint',
      model: 'gpt-5.5',
      effort: 'medium',
      gitBranch: 'main',
      startedAt: Date.parse('2026-08-17T22:14:26.483Z'),
    });
  });

  it('flags exec runs', () => {
    const exec = line({ type: 'session_meta', payload: { id: 'x', originator: 'codex_exec' } });
    expect(codexRolloutMeta(exec)?.background).toBe(true);
  });
});

describe('gemini chats', () => {
  const meta = line({
    sessionId: 'a80d26e5',
    projectHash: 'abc',
    startTime: '2026-10-07T04:30:07.225Z',
    lastUpdated: '2026-10-07T04:30:07.225Z',
    kind: 'main',
  });
  const setup = line({
    $set: {
      messages: [
        {
          id: '1',
          timestamp: '2026-10-07T04:30:07.226Z',
          type: 'user',
          content: [{ text: '<session_context>\nworkspace stuff' }],
        },
      ],
    },
  });
  const ask = (text: string) =>
    line({ $set: { messages: [{ id: '2', type: 'user', content: [{ text }] }] } });

  it('skips the setup context and reads the real prompt', () => {
    const summary = summarizeGeminiChat('fallback', [meta, setup, ask('Fix the login')], []);
    expect(summary).toMatchObject({ id: 'a80d26e5', firstPrompt: 'Fix the login' });
  });

  it('tracks first and last prompts across head and tail', () => {
    const summary = summarizeGeminiChat('fallback', [meta, ask('First')], [ask('Second')]);
    expect(summary).toMatchObject({ firstPrompt: 'First', lastPrompt: 'Second' });
  });

  it('falls back to the file id and returns null when empty', () => {
    // Setup context alone is not a conversation.
    expect(summarizeGeminiChat('file-id', [meta, setup], [])).toBeNull();
    expect(summarizeGeminiChat('file-id', [meta], [])).toBeNull();
    // Without a sessionId line the file name becomes the id.
    const noId = summarizeGeminiChat('file-id', [ask('Hello')], []);
    expect(noId).toMatchObject({ id: 'file-id', firstPrompt: 'Hello' });
  });
});

describe('continue sessions', () => {
  const doc = (overrides = {}) =>
    JSON.stringify({
      sessionId: '17cd8930',
      title: 'hi',
      workspaceDirectory: 'file:///e%3A/BitIron/VPN-App',
      history: [
        { message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
        { message: { role: 'assistant', content: '' } },
      ],
      ...overrides,
    });

  it('reads id, title, folder and prompt', () => {
    const summary = summarizeContinueSession('fallback', [doc()], []);
    expect(summary).toMatchObject({
      id: '17cd8930',
      title: 'hi',
      firstPrompt: 'hi',
      cwd: 'e:/BitIron/VPN-App',
    });
  });

  it('returns null when there is no prompt and no title', () => {
    expect(summarizeContinueSession('x', [JSON.stringify({ sessionId: 'x' })], [])).toBeNull();
  });
});

describe('cursor sessions', () => {
  it('reads cwd, title and prompts from meta plus prompt history', () => {
    const summary = summarizeCursorSession(
      'chat-id',
      ['{"cwd":"E:\\\\Runova","title":"Commit Lint Fixer"}', '["Fix the flaky tests","And lint"]'],
      [],
    );
    expect(summary).toMatchObject({
      id: 'chat-id',
      cwd: 'E:\\Runova',
      title: 'Commit Lint Fixer',
      firstPrompt: 'Fix the flaky tests',
      lastPrompt: 'And lint',
    });
  });

  it('returns null when there is nothing to show', () => {
    expect(summarizeCursorSession('x', ['{}'], [])).toBeNull();
  });
});

describe('cline sessions', () => {
  it('reads id, folder, prompt and model', () => {
    const summary = summarizeClineSession(
      'fallback',
      [
        JSON.stringify({
          session_id: '1785753303611_qbtqw',
          cwd: 'E:\\MyWebSite',
          prompt: '<user_input mode="act">Add the effect</user_input>',
          model: 'deepseek/deepseek-v4-flash',
          started_at: '2026-08-03T10:35:03.621Z',
        }),
      ],
      [],
    );
    expect(summary).toMatchObject({
      id: '1785753303611_qbtqw',
      firstPrompt: 'Add the effect',
      cwd: 'E:\\MyWebSite',
      model: 'deepseek/deepseek-v4-flash',
    });
  });

  it('returns null without a prompt', () => {
    expect(summarizeClineSession('x', [JSON.stringify({ session_id: 'x' })], [])).toBeNull();
  });
});

describe('grok chats', () => {
  const user = (text: string) => line({ type: 'user', content: [{ type: 'text', text }] });
  const assistant = line({ type: 'assistant', content: 'OK', model_id: 'grok-4.6' });

  it('reads the <user_query> ask and the model', () => {
    const summary = summarizeGrokChat(
      'sid',
      [user('<user_query>\nReply with exactly: OK\n</user_query>'), assistant],
      [],
    );
    expect(summary).toMatchObject({
      id: 'sid',
      firstPrompt: 'Reply with exactly: OK',
      model: 'grok-4.6',
    });
  });

  it('skips scaffolding messages', () => {
    expect(
      summarizeGrokChat('sid', [user('<user_info>\nOS: windows\n</user_info>')], []),
    ).toBeNull();
  });
});

describe('freebuff chats', () => {
  const userMsg = (content: string) =>
    line({ id: 'm1', variant: 'user', content, timestamp: '2026-10-12T07:30:00.000Z' });
  const aiMsg = (content: string) =>
    line({ id: 'm2', variant: 'ai', content, timestamp: '2026-10-12T07:31:00.000Z' });
  const meta = (overrides: Partial<FreebuffChatMeta> = {}): FreebuffChatMeta => ({
    messageCount: 3,
    firstPrompt: 'Fix the login',
    messagesSize: 100,
    messagesMtimeMs: 200,
    ...overrides,
  });

  it('names the project dir after the folder basename', () => {
    expect(freebuffProjectDirName('E:\\Runova')).toBe('Runova');
    expect(freebuffProjectDirName('/work/app/')).toBe('app');
  });

  it('parses the sidecar and rejects misshapen ones', () => {
    expect(parseFreebuffMeta(JSON.stringify(meta()))).toEqual(meta());
    expect(parseFreebuffMeta('not json')).toBeNull();
    expect(parseFreebuffMeta(JSON.stringify({ messageCount: 1 }))).toBeNull();
  });

  it('prefers a fresh sidecar prompt', () => {
    const summary = summarizeFreebuffChat('chat-1', meta(), 100, 200, [userMsg('Other')], []);
    expect(summary).toMatchObject({ id: 'chat-1', firstPrompt: 'Fix the login' });
  });

  it('falls back to the transcript when the sidecar is stale', () => {
    const summary = summarizeFreebuffChat(
      'chat-1',
      meta(),
      999,
      200,
      [userMsg('Transcript ask')],
      [],
    );
    expect(summary?.firstPrompt).toBe('Transcript ask');
  });

  it('reads first and last user prompts across head and tail', () => {
    const summary = summarizeFreebuffChat(
      'chat-1',
      null,
      0,
      0,
      [userMsg('First'), aiMsg('Working on it')],
      [userMsg('Follow-up')],
    );
    expect(summary).toMatchObject({ firstPrompt: 'First', lastPrompt: 'Follow-up' });
  });

  it('skips assistant-only and empty transcripts', () => {
    expect(summarizeFreebuffChat('chat-1', null, 0, 0, [aiMsg('Hi')], [])).toBeNull();
    expect(
      summarizeFreebuffChat('chat-1', meta({ firstPrompt: '(empty chat)' }), 100, 200, [], []),
    ).toBeNull();
  });
});

describe('opencode sessions', () => {
  const row = (overrides: Partial<OpencodeSessionRow> = {}): OpencodeSessionRow => ({
    id: 'ses_abc123',
    directory: 'E:/Runova',
    title: 'Fix the login',
    model: '{"id":"muse-spark","providerID":"opencode","variant":"default"}',
    time_created: 1791677642527,
    time_updated: 1791771129416,
    ...overrides,
  });

  it('reads id, folder, title, model and prompts', () => {
    const summary = summarizeOpencodeSession(row(), 'Fix it', 'Then that');
    expect(summary).toMatchObject({
      id: 'ses_abc123',
      title: 'Fix the login',
      firstPrompt: 'Fix it',
      lastPrompt: 'Then that',
      cwd: 'E:/Runova',
      model: 'muse-spark',
      startedAt: 1791677642527,
    });
  });

  it('drops the CLI-generated "New session" title', () => {
    expect(
      summarizeOpencodeSession(row({ title: 'New session - 2026-10-11T00:14:02.527Z' }), 'Hi', null)
        ?.title,
    ).toBeNull();
    // A title alone still counts as a conversation.
    expect(summarizeOpencodeSession(row({ title: 'Real title' }), null, null)).toMatchObject({
      title: 'Real title',
      firstPrompt: null,
    });
  });

  it('returns null without a prompt and without a real title', () => {
    expect(summarizeOpencodeSession(row({ title: 'New session - x' }), null, null)).toBeNull();
  });

  it('tolerates a missing or non-JSON model', () => {
    expect(summarizeOpencodeSession(row({ model: null }), 'Hi', null)?.model).toBeNull();
    expect(summarizeOpencodeSession(row({ model: 'plain-model' }), 'Hi', null)?.model).toBe(
      'plain-model',
    );
  });
});

describe('history provider coverage', () => {
  it('accounts for every CLI in the registry', () => {
    const covered = new Set<string>([...AGENT_HISTORY_PROVIDERS, ...HISTORY_UNSUPPORTED_CLIS]);
    // `codex` provider reads the `codex-cli` CLI's store.
    covered.add('codex-cli');
    const missing = CLI_REGISTRY.map((cli) => cli.id).filter((id) => !covered.has(id));
    expect(missing).toEqual([]);
  });

  it('keeps provider ids distinct and unsupported ids disjoint', () => {
    const providers = [...AGENT_HISTORY_PROVIDERS] as string[];
    expect(new Set(providers).size).toBe(providers.length);
    const overlap = (HISTORY_UNSUPPORTED_CLIS as readonly string[]).filter((id) =>
      (providers as string[]).includes(id),
    );
    expect(overlap).toEqual([]);
  });

  it('only maps codex provider to a differently-named CLI', () => {
    const sameNamed: Record<string, string> = {
      'claude-code': 'claude-code',
      openclaude: 'openclaude',
      'gemini-cli': 'gemini-cli',
      'qwen-cli': 'qwen-cli',
      'cursor-cli': 'cursor-cli',
      'continue-cli': 'continue-cli',
      'grok-cli': 'grok-cli',
      'cline-cli': 'cline-cli',
      opencode: 'opencode',
      'freebuff-cli': 'freebuff-cli',
    };
    for (const provider of AGENT_HISTORY_PROVIDERS) {
      if (provider === 'codex') continue;
      expect(sameNamed[provider as string]).toBe(provider as string);
    }
    expect('codex' as AgentHistoryProvider).toBe('codex');
  });
});
