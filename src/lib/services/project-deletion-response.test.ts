import { describe, expect, it } from 'vitest';

import { readProjectDeletionError } from './project-deletion-response';

describe('project deletion error feedback', () => {
  it('shows the API message instead of its generic error code', async () => {
    await expect(readProjectDeletionError(Response.json({
      success: false,
      error: 'CAPABILITY_DENIED',
      message: '当前账号无权删除此任务。',
    }, { status: 403 }))).resolves.toBe('当前账号无权删除此任务。');
  });

  it.each([
    [{ error: 'Project not found' }, 'Project not found'],
    [{ detail: '旧版删除错误' }, '旧版删除错误'],
    [{ message: ' ', error: '可用错误信息' }, '可用错误信息'],
    [{ message: { nested: 'invalid' }, error: '可用错误信息' }, '可用错误信息'],
  ])('supports error-only and legacy responses: %j', async (body, expected) => {
    await expect(readProjectDeletionError(Response.json(body, { status: 500 })))
      .resolves.toBe(expected);
  });

  it.each([null, {}, [], { message: 123, error: {} }])(
    'keeps malformed JSON responses actionable: %j',
    async (body) => {
      await expect(readProjectDeletionError(Response.json(body, { status: 500 })))
        .resolves.toBe('删除任务失败（HTTP 500），请稍后重试');
    },
  );

  it('identifies the HTTP failure when the route returns an HTML 404', async () => {
    const response = new Response('<html>Route not found</html>', {
      status: 404,
      headers: { 'content-type': 'text/html' },
    });
    await expect(readProjectDeletionError(response))
      .resolves.toBe('删除任务失败（HTTP 404），请稍后重试');
  });

  it('handles an empty gateway error body', async () => {
    await expect(readProjectDeletionError(new Response(null, { status: 502 })))
      .resolves.toBe('删除任务失败（HTTP 502），请稍后重试');
  });
});
