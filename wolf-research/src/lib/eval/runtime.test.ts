import { describe, expect, it } from 'vitest';

import {
  DEEPSEEK_MODEL_ID,
  LOCAL_QWEN_MODEL_ID,
} from '@/lib/constants/models';
import { __evalRuntimeTesting } from './runtime';

describe('evaluation runtime selection', () => {
  it('preserves the registered official DeepSeek model requested by the UI', () => {
    const item = __evalRuntimeTesting.buildVirtualQueueItem({
      cli: 'pi',
      model: DEEPSEEK_MODEL_ID,
      evaluatorId: 'agent-review',
      mode: 'e2e',
    });

    expect(item).toMatchObject({
      cli: 'pi',
      model: DEEPSEEK_MODEL_ID,
      evaluatorId: 'agent-review',
      mode: 'e2e',
    });
  });

  it('uses the registered runtime default only when no model was requested', () => {
    expect(__evalRuntimeTesting.buildVirtualQueueItem()).toMatchObject({
      cli: 'pi',
      model: LOCAL_QWEN_MODEL_ID,
    });
  });

  it('rejects unknown runtimes and models instead of silently selecting Qwen', () => {
    expect(() => __evalRuntimeTesting.buildVirtualQueueItem({
      cli: 'unknown',
    })).toThrow('未注册评测运行器：unknown');

    expect(() => __evalRuntimeTesting.buildVirtualQueueItem({
      cli: 'pi',
      model: 'unregistered-model',
    })).toThrow('运行器 pi 未注册评测模型：unregistered-model');
  });
});
