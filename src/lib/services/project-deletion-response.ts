/** Reads the deletion API's error contract, including non-JSON startup failures. */
export async function readProjectDeletionError(
  response: Pick<Response, 'status' | 'json'>,
): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (body && typeof body === 'object') {
    const fields = body as Record<string, unknown>;
    for (const key of ['message', 'error', 'detail']) {
      const value = fields[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }

  return `删除任务失败（HTTP ${response.status}），请稍后重试`;
}
