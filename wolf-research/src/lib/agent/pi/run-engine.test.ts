import { describe, expect, it, vi } from 'vitest';

import type {
  PiAgentEvent,
  PiAgentMessage,
  PiAgentModelEvent,
  PiAgentModelProvider,
  PiAgentModelRequest,
  PiAgentTokenUsage,
  PiAgentTool,
  PiAgentToolContext,
  PiAgentToolResult,
} from '../types';
import {
  PiAgentRunEngine,
  usageFromPi,
  usageToPi,
} from './run-engine';
import { PiAgentDeterministicToolPlanProvider } from '../providers/deterministic-tool-plan';

type ProviderScript = readonly PiAgentModelEvent[];

class ScriptedProvider implements PiAgentModelProvider {
  readonly name = 'pi-scripted';
  readonly requests: PiAgentModelRequest[] = [];
  private readonly scripts: ProviderScript[];

  constructor(scripts: ProviderScript[]) {
    this.scripts = [...scripts];
  }

  complete(request: PiAgentModelRequest): AsyncIterable<PiAgentModelEvent> {
    this.requests.push({
      ...request,
      messages: structuredClone(request.messages),
      tools: request.tools?.map((tool) => structuredClone(tool)),
    });
    const script = this.scripts.shift();
    return {
      async *[Symbol.asyncIterator]() {
        if (!script) throw new Error('No scripted provider turn remains.');
        for (const event of script) yield event;
      },
    };
  }
}

const initialMessages: PiAgentMessage[] = [{
  role: 'user',
  content: 'Complete the governed task.',
}];

function usage(options: {
  input: number;
  output: number;
  cached?: number;
  cacheMiss?: number;
}): PiAgentModelEvent {
  const cachedInputTokens = options.cached ?? 0;
  const cacheMissInputTokens = options.cacheMiss ??
    options.input - cachedInputTokens;
  return {
    type: 'usage',
    usage: {
      inputTokens: options.input,
      outputTokens: options.output,
      totalTokens: options.input + options.output,
      cachedInputTokens,
      cacheMissInputTokens,
    },
  };
}

function toolTurn(
  calls: Array<{ id: string; name: string; arguments: string }>,
  turnUsage: PiAgentModelEvent = usage({ input: 1, output: 1 }),
): ProviderScript {
  return [
    {
      type: 'response_start',
      responseId: `response-${calls.map((call) => call.id).join('-')}`,
      model: 'test-model',
    },
    ...calls.map((call, index): PiAgentModelEvent => ({
      type: 'tool_call_delta',
      index,
      id: call.id,
      nameDelta: call.name,
      argumentsDelta: call.arguments,
    })),
    turnUsage,
    { type: 'finish', reason: 'tool_calls', rawReason: 'tool_calls' },
  ];
}

function objectSchema(
  properties: Record<string, Record<string, unknown>> = {},
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function terminalTool(
  execute = vi.fn(async (input: unknown) => ({
    ok: true as const,
    data: input,
  })),
): PiAgentTool {
  return {
    name: 'submit_result',
    description: 'Submit the completed result.',
    inputSchema: objectSchema(
      { artifact: { type: 'string' } },
      ['artifact'],
    ),
    terminal: true,
    execute,
  };
}

describe('PiAgentRunEngine', () => {
  it('rejects unsafe run identifiers before starting PI', async () => {
    const provider = new ScriptedProvider([]);
    const engine = new PiAgentRunEngine({
      provider,
      model: 'test-model',
      requireTerminalTool: false,
    });

    await expect(engine.run({
      runId: 'unsafe\nrun',
      messages: initialMessages,
    })).rejects.toThrow('runId must be');
    expect(provider.requests).toHaveLength(0);
  });

  it('lets PI own a real multi-turn tool loop and preserves ordered usage', async () => {
    const provider = new ScriptedProvider([
      toolTurn(
        [{
          id: 'call-lookup',
          name: 'lookup',
          arguments: '{"symbol":"600519.SH"}',
        }],
        usage({ input: 10, output: 3, cached: 4, cacheMiss: 6 }),
      ),
      toolTurn(
        [{
          id: 'call-submit',
          name: 'submit_result',
          arguments: '{"artifact":"app/page.tsx"}',
        }],
        usage({ input: 20, output: 4, cached: 5, cacheMiss: 15 }),
      ),
    ]);
    const executionOrder: string[] = [];
    const lookup = vi.fn(async (input: unknown) => {
      executionOrder.push('lookup');
      return { ok: true as const, data: { input, price: 1_500 } };
    });
    const submit = vi.fn(async (input: unknown) => {
      executionOrder.push('submit');
      return { ok: true as const, data: input };
    });
    const events: PiAgentEvent[] = [];
    const engine = new PiAgentRunEngine({
      provider,
      model: 'test-model',
      tools: [
        {
          name: 'lookup',
          description: 'Look up a symbol.',
          inputSchema: objectSchema(
            { symbol: { type: 'string' } },
            ['symbol'],
          ),
          effect: 'read',
          execute: lookup,
        },
        terminalTool(submit),
      ],
    });

    const result = await engine.run({
      runId: 'pi-multi-turn',
      messages: initialMessages,
    }, (event) => {
      events.push(event);
    });

    expect(result).toMatchObject({
      status: 'completed',
      turns: 2,
      usage: {
        inputTokens: 30,
        outputTokens: 7,
        totalTokens: 37,
        cachedInputTokens: 9,
        cacheMissInputTokens: 21,
      },
      terminalToolCall: {
        id: 'call-submit',
        name: 'submit_result',
      },
    });
    expect(executionOrder).toEqual(['lookup', 'submit']);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1].messages).toContainEqual(
      expect.objectContaining({
        role: 'tool',
        toolCallId: 'call-lookup',
        name: 'lookup',
      }),
    );
    expect(result.messages[0]).toEqual(initialMessages[0]);
    const boundaries = events
      .filter((event) =>
        event.type === 'tool_started' ||
        event.type === 'tool_completed')
      .map((event) =>
        `${event.type}:${event.type === 'tool_started' ||
          event.type === 'tool_completed'
          ? event.toolCall.name
          : ''}`);
    expect(boundaries).toEqual([
      'tool_started:lookup',
      'tool_completed:lookup',
      'tool_started:submit_result',
      'tool_completed:submit_result',
    ]);
  });

  it('executes a deterministic trusted plan through the same governed loop as HTTP runs', async () => {
    const executionOrder: string[] = [];
    const events: PiAgentEvent[] = [];
    const applyDashboard = vi.fn(async () => {
      executionOrder.push('apply_dashboard_spec');
      return { ok: true as const, data: { artifact: 'app/page.tsx' } };
    });
    const submit = vi.fn(async () => {
      executionOrder.push('submit_result');
      return { ok: true as const, data: { submitted: true } };
    });
    const engine = new PiAgentRunEngine({
      provider: new PiAgentDeterministicToolPlanProvider({
        name: 'pi-agent-trusted-renderer',
        steps: [
          {
            name: 'apply_dashboard_spec',
            arguments: { templateId: 'finance-overview', variantId: 'compact' },
          },
          {
            name: 'submit_result',
            arguments: {
              summary: 'deterministic dashboard',
              artifacts: ['app/page.tsx'],
              notes: 'trusted renderer',
            },
          },
        ],
      }),
      model: 'pi-agent-deterministic-renderer-v1',
      maxTurns: 4,
      maxTokens: 1,
      maxTokensPerTurn: 1,
      requireTerminalTool: true,
      requireWorkspaceWriteBeforeTerminal: true,
      tools: [
        {
          name: 'apply_dashboard_spec',
          description: 'Compile the trusted dashboard.',
          inputSchema: objectSchema(
            {
              templateId: { type: 'string' },
              variantId: { type: 'string' },
            },
            ['templateId', 'variantId'],
          ),
          effect: 'workspace_write',
          execute: applyDashboard,
        },
        {
          name: 'submit_result',
          description: 'Submit the generated dashboard.',
          inputSchema: objectSchema(
            {
              summary: { type: 'string' },
              artifacts: { type: 'array', items: { type: 'string' } },
              notes: { type: 'string' },
            },
            ['summary', 'artifacts', 'notes'],
          ),
          terminal: true,
          execute: submit,
        },
      ],
    });

    const result = await engine.run({
      runId: 'pi-deterministic-plan',
      messages: initialMessages,
      reasoning: { enabled: false },
    }, (event) => {
      events.push(event);
    });

    expect(result).toMatchObject({
      status: 'completed',
      turns: 2,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      terminalToolCall: {
        name: 'submit_result',
      },
    });
    expect(executionOrder).toEqual(['apply_dashboard_spec', 'submit_result']);
    expect(events.filter((event) => event.type === 'tool_started')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'tool_completed')).toHaveLength(2);
  });

  it('forces a prepared custom surface to submit after a successful semantic edit', async () => {
    const provider = new ScriptedProvider([
      toolTurn([{
        id: 'call-edit',
        name: 'semantic_edit',
        arguments: '{"path":"app/page.tsx"}',
      }]),
      toolTurn([{
        id: 'call-submit',
        name: 'submit_result',
        arguments: '{"artifact":"app/page.tsx"}',
      }]),
    ]);
    const edit = vi.fn(async (input: unknown) => ({
      ok: true as const,
      data: { input, path: 'app/page.tsx' },
    }));
    const submit = vi.fn(async (input: unknown) => ({
      ok: true as const,
      data: input,
    }));
    const engine = new PiAgentRunEngine({
      provider,
      model: 'test-model',
      preparedSurface: 'custom',
      requireTerminalTool: true,
      requireWorkspaceWriteBeforeTerminal: true,
      tools: [
        {
          name: 'semantic_edit',
          description: 'Edit one prepared source target.',
          inputSchema: objectSchema(
            { path: { type: 'string' } },
            ['path'],
          ),
          effect: 'workspace_write',
          execute: edit,
        },
        terminalTool(submit),
      ],
    });

    const result = await engine.run({
      runId: 'pi-custom-edit-submit',
      messages: initialMessages,
    });

    expect(result).toMatchObject({
      status: 'completed',
      terminalToolCall: { name: 'submit_result' },
    });
    expect(edit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
    expect(provider.requests[1].tools).toEqual([
      expect.objectContaining({ name: 'submit_result' }),
    ]);
    expect(provider.requests[1].toolChoice).toEqual({ name: 'submit_result' });
  });

  it('fails a prepared custom surface when the turn after editing does not submit', async () => {
    const provider = new ScriptedProvider([
      toolTurn([{
        id: 'call-edit',
        name: 'semantic_edit',
        arguments: '{"path":"app/page.tsx"}',
      }]),
      toolTurn([{
        id: 'call-read',
        name: 'read_file',
        arguments: '{"path":"app/page.tsx"}',
      }]),
    ]);
    const read = vi.fn(async () => ({
      ok: true as const,
      data: { path: 'app/page.tsx' },
    }));
    const engine = new PiAgentRunEngine({
      provider,
      model: 'test-model',
      preparedSurface: 'custom',
      requireTerminalTool: true,
      requireWorkspaceWriteBeforeTerminal: true,
      tools: [
        {
          name: 'semantic_edit',
          description: 'Edit one prepared source target.',
          inputSchema: objectSchema(
            { path: { type: 'string' } },
            ['path'],
          ),
          effect: 'workspace_write',
          execute: async () => ({
            ok: true as const,
            data: { path: 'app/page.tsx' },
          }),
        },
        {
          name: 'read_file',
          description: 'Read one prepared source target.',
          inputSchema: objectSchema(
            { path: { type: 'string' } },
            ['path'],
          ),
          effect: 'read',
          observationCache: 'workspace_generation',
          execute: read,
        },
        terminalTool(),
      ],
    });

    const result = await engine.run({
      runId: 'pi-custom-edit-without-submit',
      messages: initialMessages,
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'CUSTOM_SUBMISSION_REQUIRED' },
    });
    expect(read).not.toHaveBeenCalled();
    expect(provider.requests[1].tools).toEqual([
      expect.objectContaining({ name: 'submit_result' }),
    ]);
  });

  it('blocks repeated cached observations only on the prepared custom surface', async () => {
    const readTool = (read: ReturnType<typeof vi.fn>): PiAgentTool => ({
      name: 'read_file',
      description: 'Read one prepared source target.',
      inputSchema: objectSchema(
        { path: { type: 'string' } },
        ['path'],
      ),
      effect: 'read',
      observationCache: 'workspace_generation',
      execute: read as unknown as PiAgentTool['execute'],
    });
    const repeatedCall = (id: string) => toolTurn([{
      id,
      name: 'read_file',
      arguments: '{"path":"app/page.tsx"}',
    }]);

    const customRead = vi.fn(async () => ({
      ok: true as const,
      data: { path: 'app/page.tsx' },
    }));
    const customProvider = new ScriptedProvider([
      repeatedCall('custom-read-1'),
      repeatedCall('custom-read-2'),
    ]);
    const customEngine = new PiAgentRunEngine({
      provider: customProvider,
      model: 'test-model',
      preparedSurface: 'custom',
      requireTerminalTool: false,
      tools: [readTool(customRead)],
    });
    const customResult = await customEngine.run({
      runId: 'pi-custom-repeated-read',
      messages: initialMessages,
    });

    expect(customResult).toMatchObject({
      status: 'failed',
      error: { code: 'OBSERVATION_REUSED' },
    });
    expect(customRead).toHaveBeenCalledOnce();

    const ordinaryRead = vi.fn(async () => ({
      ok: true as const,
      data: { path: 'app/page.tsx' },
    }));
    const ordinaryProvider = new ScriptedProvider([
      repeatedCall('ordinary-read-1'),
      repeatedCall('ordinary-read-2'),
      [
        {
          type: 'response_start',
          responseId: 'ordinary-stop',
          model: 'test-model',
        },
        usage({ input: 1, output: 1 }),
        { type: 'finish', reason: 'stop' },
      ],
    ]);
    const ordinaryEngine = new PiAgentRunEngine({
      provider: ordinaryProvider,
      model: 'test-model',
      requireTerminalTool: false,
      tools: [readTool(ordinaryRead)],
    });
    const ordinaryResult = await ordinaryEngine.run({
      runId: 'pi-ordinary-repeated-read',
      messages: initialMessages,
    });

    expect(ordinaryResult.status).toBe('completed');
    expect(ordinaryRead).toHaveBeenCalledTimes(2);
  });

  it('preserves the custom read budget across neutral turns before a workspace write', async () => {
    const read = vi.fn(async (input: unknown) => ({
      ok: true as const,
      data: { input },
    }));
    const neutral = vi.fn(async () => ({
      ok: true as const,
      data: { observed: true },
    }));
    const readTool = (execute: ReturnType<typeof vi.fn>): PiAgentTool => ({
      name: 'read_file',
      description: 'Read one prepared source target.',
      inputSchema: objectSchema(
        {
          path: { type: 'string' },
          startLine: { type: 'number' },
          endLine: { type: 'number' },
        },
        ['path', 'startLine', 'endLine'],
      ),
      effect: 'read',
      observationCache: 'workspace_generation',
      execute: execute as unknown as PiAgentTool['execute'],
    });
    const provider = new ScriptedProvider([
      toolTurn([{
        id: 'budget-read-1',
        name: 'read_file',
        arguments: '{"path":"app/page.tsx","startLine":1,"endLine":20}',
      }]),
      toolTurn([{
        id: 'budget-neutral',
        name: 'observe_state',
        arguments: '{}',
      }]),
      toolTurn([{
        id: 'budget-read-2',
        name: 'read_file',
        arguments: '{"path":"app/page.tsx","startLine":21,"endLine":40}',
      }]),
      toolTurn([{
        id: 'budget-read-3',
        name: 'read_file',
        arguments: '{"path":"app/page.tsx","startLine":41,"endLine":60}',
      }]),
      [
        {
          type: 'response_start',
          responseId: 'budget-stop',
          model: 'test-model',
        },
        usage({ input: 1, output: 1 }),
        { type: 'finish', reason: 'stop' },
      ],
    ]);
    const engine = new PiAgentRunEngine({
      provider,
      model: 'test-model',
      preparedSurface: 'custom',
      preWriteReadOnlyTurnThreshold: 2,
      requireTerminalTool: false,
      tools: [
        readTool(read),
        {
          name: 'observe_state',
          description: 'Observe trusted state without changing the workspace.',
          inputSchema: objectSchema(),
          effect: 'pure',
          execute: neutral,
        },
      ],
    });

    const result = await engine.run({
      runId: 'pi-custom-neutral-read-budget',
      messages: initialMessages,
    });

    expect(result.status).toBe('completed');
    expect(read).toHaveBeenCalledTimes(2);
    expect(neutral).toHaveBeenCalledOnce();
    expect(provider.requests[3].tools).toEqual([
      expect.objectContaining({ name: 'observe_state' }),
    ]);
  });

  it('forces semantic_edit after the custom read budget and submit_result after editing', async () => {
    const provider = new ScriptedProvider([
      toolTurn([{
        id: 'forced-read',
        name: 'read_file',
        arguments: '{"path":"app/page.tsx","startLine":1,"endLine":20}',
      }]),
      toolTurn([{
        id: 'forced-edit',
        name: 'semantic_edit',
        arguments: '{"path":"app/page.tsx"}',
      }]),
      toolTurn([{
        id: 'forced-submit',
        name: 'submit_result',
        arguments: '{"artifact":"app/page.tsx"}',
      }]),
    ]);
    const read = vi.fn(async () => ({
      ok: true as const,
      data: { path: 'app/page.tsx' },
    }));
    const edit = vi.fn(async () => ({
      ok: true as const,
      data: { path: 'app/page.tsx' },
    }));
    const submit = vi.fn(async () => ({
      ok: true as const,
      data: { submitted: true },
    }));
    const engine = new PiAgentRunEngine({
      provider,
      model: 'test-model',
      preparedSurface: 'custom',
      preWriteReadOnlyTurnThreshold: 1,
      requireTerminalTool: true,
      requireWorkspaceWriteBeforeTerminal: true,
      tools: [
        {
          name: 'read_file',
          description: 'Read one prepared source target.',
          inputSchema: objectSchema(
            {
              path: { type: 'string' },
              startLine: { type: 'number' },
              endLine: { type: 'number' },
            },
            ['path', 'startLine', 'endLine'],
          ),
          effect: 'read',
          observationCache: 'workspace_generation',
          execute: read,
        },
        {
          name: 'semantic_edit',
          description: 'Edit one prepared source target.',
          inputSchema: objectSchema(
            { path: { type: 'string' } },
            ['path'],
          ),
          effect: 'workspace_write',
          execute: edit,
        },
        terminalTool(submit),
      ],
    });

    const result = await engine.run({
      runId: 'pi-custom-forced-tool-choice',
      messages: initialMessages,
    });

    expect(result).toMatchObject({
      status: 'completed',
      turns: 3,
      terminalToolCall: { name: 'submit_result' },
    });
    expect(read).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
    expect(provider.requests[1].tools).toEqual([
      expect.objectContaining({ name: 'semantic_edit' }),
    ]);
    expect(provider.requests[1].messages.at(-1)).toEqual(expect.objectContaining({
      role: 'user',
      content: expect.stringContaining('exhausted its read-only budget'),
    }));
    expect(provider.requests[1].toolChoice).toEqual({ name: 'semantic_edit' });
    expect(provider.requests[2].tools).toEqual([
      expect.objectContaining({ name: 'submit_result' }),
    ]);
    expect(provider.requests[2].messages.at(-1)).toEqual(expect.objectContaining({
      role: 'user',
      content: expect.stringContaining('semantic_edit succeeded'),
    }));
    expect(provider.requests[2].toolChoice).toEqual({ name: 'submit_result' });
  });

  it('allows distinct bounded observations of one file on the prepared custom surface', async () => {
    let readCalls = 0;
    const read = async (
      _input: unknown,
      _context: PiAgentToolContext,
    ): Promise<PiAgentToolResult<{ path: string }>> => {
      readCalls += 1;
      return {
        ok: true,
        data: { path: 'app/page.tsx' },
      };
    };
    const provider = new ScriptedProvider([
      toolTurn([{
        id: 'distinct-read-1',
        name: 'read_file',
        arguments: '{"path":"app/page.tsx","startLine":1,"endLine":20}',
      }]),
      toolTurn([{
        id: 'distinct-read-2',
        name: 'read_file',
        arguments: '{"path":"app/page.tsx","startLine":21,"endLine":40}',
      }]),
      [
        {
          type: 'response_start',
          responseId: 'distinct-stop',
          model: 'test-model',
        },
        usage({ input: 1, output: 1 }),
        { type: 'finish', reason: 'stop' },
      ],
    ]);
    const engine = new PiAgentRunEngine({
      provider,
      model: 'test-model',
      preparedSurface: 'custom',
      requireTerminalTool: false,
      tools: [{
        name: 'read_file',
        description: 'Read one prepared source target.',
        inputSchema: objectSchema(
          {
            path: { type: 'string' },
            startLine: { type: 'number' },
            endLine: { type: 'number' },
          },
          ['path', 'startLine', 'endLine'],
        ),
        effect: 'read',
        observationCache: 'workspace_generation',
        execute: read,
      }],
    });

    const result = await engine.run({
      runId: 'pi-custom-distinct-reads',
      messages: initialMessages,
    });

    expect(result.status).toBe('completed');
    expect(readCalls).toBe(2);
  });

  it('runs approval only after the original arguments pass the PI schema', async () => {
    const provider = new ScriptedProvider([
      toolTurn([{
        id: 'call-publish-invalid',
        name: 'publish_report',
        arguments: '{}',
      }]),
      toolTurn([{
        id: 'call-submit',
        name: 'submit_result',
        arguments: '{"artifact":"report.md"}',
      }]),
    ]);
    const approval = vi.fn(async () => ({
      decision: 'approve' as const,
    }));
    const publish = vi.fn(async () => ({
      ok: true as const,
      data: {},
    }));
    const events: PiAgentEvent[] = [];
    const engine = new PiAgentRunEngine({
      provider,
      model: 'test-model',
      tools: [
        {
          name: 'publish_report',
          description: 'Publish a report.',
          inputSchema: objectSchema(
            { title: { type: 'string' } },
            ['title'],
          ),
          effect: 'external_write',
          approval: {
            reason: 'Publishing is externally visible.',
            projectPublicInput: (input) =>
              input as Record<string, string>,
          },
          execute: publish,
        },
        terminalTool(),
      ],
      toolApprovalHandler: approval,
    });

    const result = await engine.run({
      runId: 'pi-schema-before-approval',
      messages: initialMessages,
    }, (event) => {
      events.push(event);
    });

    expect(result.status).toBe('completed');
    expect(approval).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'tool_started',
      toolCall: expect.objectContaining({ name: 'publish_report' }),
    }));
    const failedResult = provider.requests[1].messages.find(
      (message) =>
        message.role === 'tool' &&
        message.toolCallId === 'call-publish-invalid',
    );
    expect(failedResult?.role === 'tool'
      ? failedResult.content
      : '').toContain('Validation failed');
  });

  it('revalidates an approved edit with the PI schema before durable start', async () => {
    const provider = new ScriptedProvider([
      toolTurn([{
        id: 'call-publish',
        name: 'publish_report',
        arguments: '{"channel":"draft","title":"Initial"}',
      }]),
    ]);
    const publish = vi.fn(async () => ({
      ok: true as const,
      data: {},
    }));
    const events: PiAgentEvent[] = [];
    const engine = new PiAgentRunEngine({
      provider,
      model: 'test-model',
      requireTerminalTool: false,
      tools: [{
        name: 'publish_report',
        description: 'Publish a report.',
        inputSchema: objectSchema(
          {
            channel: { type: 'string' },
            title: { type: 'string' },
          },
          ['channel', 'title'],
        ),
        effect: 'external_write',
        approval: {
          reason: 'Publishing is externally visible.',
          allowedDecisions: ['approve', 'edit', 'reject'],
          projectPublicInput: (input) =>
            input as Record<string, string>,
        },
        execute: publish,
      }],
      toolApprovalHandler: async () => ({
        decision: 'edit',
        editedInput: { channel: 'approved' },
      }),
    });

    const result = await engine.run({
      runId: 'pi-invalid-approval-edit',
      messages: initialMessages,
    }, (event) => {
      events.push(event);
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'TOOL_APPROVAL_FAILED' },
    });
    expect(publish).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toContain(
      'tool_approval_requested',
    );
    expect(events.map((event) => event.type)).not.toContain(
      'tool_approval_resolved',
    );
    expect(events.map((event) => event.type)).not.toContain('tool_started');
  });

  it('executes the schema-validated approved edit instead of the original args', async () => {
    const provider = new ScriptedProvider([
      toolTurn([{
        id: 'call-publish',
        name: 'publish_report',
        arguments: '{"channel":"draft","title":"Initial"}',
      }]),
    ]);
    const publish = vi.fn(async (input: unknown) => ({
      ok: true as const,
      data: input,
    }));
    const events: PiAgentEvent[] = [];
    const engine = new PiAgentRunEngine({
      provider,
      model: 'test-model',
      requireTerminalTool: false,
      maxTurns: 1,
      tools: [{
        name: 'publish_report',
        description: 'Publish a report.',
        inputSchema: objectSchema(
          {
            channel: { type: 'string' },
            title: { type: 'string' },
          },
          ['channel', 'title'],
        ),
        effect: 'external_write',
        approval: {
          reason: 'Publishing is externally visible.',
          allowedDecisions: ['approve', 'edit', 'reject'],
          projectPublicInput: (input) =>
            input as Record<string, string>,
        },
        execute: publish,
      }],
      toolApprovalHandler: async () => ({
        decision: 'edit',
        resolvedBy: 'reviewer-1',
        editedInput: {
          channel: 'approved',
          title: 'Reviewed',
        },
      }),
    });

    const result = await engine.run({
      runId: 'pi-valid-approval-edit',
      messages: initialMessages,
    }, (event) => {
      events.push(event);
    });

    expect(result).toMatchObject({
      status: 'max_turns',
      error: { code: 'MAX_TURNS' },
    });
    expect(publish).toHaveBeenCalledWith(
      { channel: 'approved', title: 'Reviewed' },
      expect.any(Object),
    );
    const started = events.find(
      (event) => event.type === 'tool_started',
    );
    expect(started?.type === 'tool_started'
      ? JSON.parse(started.toolCall.arguments)
      : null).toEqual({
      channel: 'approved',
      title: 'Reviewed',
    });
    const eventTypes = events.map((event) => event.type);
    expect(eventTypes.indexOf('tool_approval_resolved')).toBeLessThan(
      eventTypes.indexOf('tool_started'),
    );
  });

  it('persists tool_started before allowing the side effect', async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      data: {},
    }));
    const provider = new ScriptedProvider([
      toolTurn([{
        id: 'call-write',
        name: 'write_file',
        arguments: '{"path":"app/page.tsx"}',
      }]),
    ]);
    const engine = new PiAgentRunEngine({
      provider,
      model: 'test-model',
      requireTerminalTool: false,
      tools: [{
        name: 'write_file',
        description: 'Write a file.',
        inputSchema: objectSchema(
          { path: { type: 'string' } },
          ['path'],
        ),
        effect: 'workspace_write',
        execute,
      }],
    });

    const result = await engine.run({
      runId: 'pi-start-ledger-failure',
      messages: initialMessages,
    }, {
      durableSink: (event) => {
        if (event.type === 'tool_started') {
          throw new Error('tool ledger unavailable');
        }
      },
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'TOOL_PIPELINE_FAILED' },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('stops sequential siblings when a mutating outcome cannot be persisted', async () => {
    const first = vi.fn(async () => ({
      ok: true as const,
      data: { path: 'first.ts' },
    }));
    const second = vi.fn(async () => ({
      ok: true as const,
      data: { path: 'second.ts' },
    }));
    const provider = new ScriptedProvider([
      toolTurn([
        {
          id: 'call-first',
          name: 'write_first',
          arguments: '{}',
        },
        {
          id: 'call-second',
          name: 'write_second',
          arguments: '{}',
        },
      ]),
    ]);
    const events: PiAgentEvent[] = [];
    const engine = new PiAgentRunEngine({
      provider,
      model: 'test-model',
      requireTerminalTool: false,
      tools: [
        {
          name: 'write_first',
          description: 'First write.',
          inputSchema: objectSchema(),
          effect: 'workspace_write',
          execute: first,
        },
        {
          name: 'write_second',
          description: 'Second write.',
          inputSchema: objectSchema(),
          effect: 'workspace_write',
          execute: second,
        },
      ],
    });

    const result = await engine.run({
      runId: 'pi-outcome-ledger-failure',
      messages: initialMessages,
    }, {
      durableSink: (event) => {
        events.push(event);
        if (
          event.type === 'tool_completed' &&
          event.toolCall.name === 'write_first'
        ) {
          throw new Error('outcome ledger unavailable');
        }
      },
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'MUTATION_RECONCILIATION_REQUIRED' },
    });
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'tool_started',
      toolCall: expect.objectContaining({ name: 'write_second' }),
    }));
  });

  it('stops sequential siblings after an uncertain mutating result', async () => {
    const first = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'REMOTE_WRITE_TIMEOUT',
        message: 'The remote write may have committed.',
      },
    }));
    const second = vi.fn(async () => ({
      ok: true as const,
      data: {},
    }));
    const provider = new ScriptedProvider([
      toolTurn([
        {
          id: 'call-first',
          name: 'external_first',
          arguments: '{}',
        },
        {
          id: 'call-second',
          name: 'external_second',
          arguments: '{}',
        },
      ]),
    ]);
    const events: PiAgentEvent[] = [];
    const engine = new PiAgentRunEngine({
      provider,
      model: 'test-model',
      requireTerminalTool: false,
      tools: [
        {
          name: 'external_first',
          description: 'First external write.',
          inputSchema: objectSchema(),
          effect: 'external_write',
          execute: first,
        },
        {
          name: 'external_second',
          description: 'Second external write.',
          inputSchema: objectSchema(),
          effect: 'external_write',
          execute: second,
        },
      ],
    });

    const result = await engine.run({
      runId: 'pi-uncertain-mutation',
      messages: initialMessages,
    }, (event) => {
      events.push(event);
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'MUTATION_RECONCILIATION_REQUIRED' },
    });
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_failed',
      toolCall: expect.objectContaining({ name: 'external_first' }),
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'tool_started',
      toolCall: expect.objectContaining({ name: 'external_second' }),
    }));
  });

  it('rejects a mixed terminal batch before any side effect starts', async () => {
    const write = vi.fn(async () => ({
      ok: true as const,
      data: {},
    }));
    const submit = vi.fn(async () => ({
      ok: true as const,
      data: {},
    }));
    const provider = new ScriptedProvider([
      toolTurn([
        {
          id: 'call-write',
          name: 'write_file',
          arguments: '{}',
        },
        {
          id: 'call-submit',
          name: 'submit_result',
          arguments: '{"artifact":"app/page.tsx"}',
        },
      ]),
    ]);
    const events: PiAgentEvent[] = [];
    const engine = new PiAgentRunEngine({
      provider,
      model: 'test-model',
      tools: [
        {
          name: 'write_file',
          description: 'Write a file.',
          inputSchema: objectSchema(),
          effect: 'workspace_write',
          execute: write,
        },
        terminalTool(submit),
      ],
    });

    const result = await engine.run({
      runId: 'pi-terminal-exclusive',
      messages: initialMessages,
    }, (event) => {
      events.push(event);
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'TERMINAL_TOOL_NOT_EXCLUSIVE' },
    });
    expect(write).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).not.toContain('tool_started');
  });

  it('preflights duplicate IDs and tool budgets before any tool starts', async () => {
    const scenarios = [
      {
        runId: 'pi-duplicate-tool-call',
        expectedCode: 'DUPLICATE_TOOL_CALL_ID',
        options: {},
        calls: [
          { id: 'duplicate', name: 'lookup', arguments: '{}' },
          { id: 'duplicate', name: 'lookup', arguments: '{}' },
        ],
      },
      {
        runId: 'pi-turn-tool-budget',
        expectedCode: 'MAX_TOOL_CALLS_PER_TURN',
        options: { maxToolCallsPerTurn: 1 },
        calls: [
          { id: 'first', name: 'lookup', arguments: '{}' },
          { id: 'second', name: 'lookup', arguments: '{}' },
        ],
      },
      {
        runId: 'pi-argument-budget',
        expectedCode: 'MAX_TOOL_ARGUMENT_CHARS',
        options: { maxToolArgumentChars: 5 },
        calls: [{
          id: 'oversized',
          name: 'lookup',
          arguments: '{"value":"too-long"}',
        }],
      },
    ] as const;

    for (const scenario of scenarios) {
      const execute = vi.fn(async () => ({
        ok: true as const,
        data: {},
      }));
      const provider = new ScriptedProvider([toolTurn([...scenario.calls])]);
      const events: PiAgentEvent[] = [];
      const engine = new PiAgentRunEngine({
        provider,
        model: 'test-model',
        requireTerminalTool: false,
        tools: [{
          name: 'lookup',
          description: 'Read a governed value.',
          inputSchema: objectSchema(),
          effect: 'read',
          execute,
        }],
        ...scenario.options,
      });

      const result = await engine.run({
        runId: scenario.runId,
        messages: initialMessages,
      }, (event) => {
        events.push(event);
      });

      expect(result).toMatchObject({
        status: 'failed',
        error: { code: scenario.expectedCode },
      });
      expect(execute).not.toHaveBeenCalled();
      expect(events.map((event) => event.type)).not.toContain('tool_started');
    }
  });

  it('rejects unsafe provider tool-call IDs before any side effect starts', async () => {
    const write = vi.fn(async () => ({
      ok: true as const,
      data: {},
    }));
    const provider = new ScriptedProvider([
      toolTurn([{
        id: 'unsafe\ncall',
        name: 'write_file',
        arguments: '{}',
      }]),
    ]);
    const engine = new PiAgentRunEngine({
      provider,
      model: 'test-model',
      requireTerminalTool: false,
      tools: [{
        name: 'write_file',
        description: 'Write a file.',
        inputSchema: objectSchema(),
        effect: 'workspace_write',
        execute: write,
      }],
    });

    const result = await engine.run({
      runId: 'pi-invalid-tool-call-id',
      messages: initialMessages,
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'INVALID_TOOL_CALL_ID' },
    });
    expect(write).not.toHaveBeenCalled();
  });
});

describe('PI usage mapping', () => {
  it('maps cache reads and writes without undercounting full input', () => {
    const piUsage = {
      input: 6,
      output: 3,
      cacheRead: 4,
      cacheWrite: 2,
      reasoning: 1,
      totalTokens: 15,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    };

    expect(usageFromPi(piUsage)).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      cachedInputTokens: 4,
      cacheMissInputTokens: 8,
      reasoningTokens: 1,
    });

    const hostUsage: PiAgentTokenUsage = {
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      cachedInputTokens: 4,
      cacheMissInputTokens: 8,
      reasoningTokens: 1,
    };
    expect(usageToPi(hostUsage)).toMatchObject({
      input: 8,
      output: 3,
      cacheRead: 4,
      cacheWrite: 0,
      totalTokens: 15,
      reasoning: 1,
    });
  });
});
