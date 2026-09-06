import { describe, expect, it } from 'vitest';

import {
  PREPARED_CUSTOM_SEMANTIC_EDIT_SUBMIT_HINT,
  SEMANTIC_EDIT_CSS_APPEND_LIMIT_TEXT,
} from '@/lib/agent/tools/semantic-edit-contract';

import { buildQuantPilotSystemPrompt } from './pi-agent-prompts';

describe('buildQuantPilotSystemPrompt', () => {
  it('publishes the CSS append hard limits to the model', () => {
    expect(buildQuantPilotSystemPrompt()).toContain(
      SEMANTIC_EDIT_CSS_APPEND_LIMIT_TEXT,
    );
  });

  it('requires immediate terminal submission only for the prepared custom lane', () => {
    expect(buildQuantPilotSystemPrompt({
      phase: 'workspace-generation',
      preparedIntent: 'custom',
    })).toContain(PREPARED_CUSTOM_SEMANTIC_EDIT_SUBMIT_HINT);
    expect(buildQuantPilotSystemPrompt({
      phase: 'workspace-generation',
      preparedIntent: 'standard',
    })).not.toContain(PREPARED_CUSTOM_SEMANTIC_EDIT_SUBMIT_HINT);
  });
});
