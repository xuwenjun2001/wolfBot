import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { AuthorizationError } from '@/lib/auth/authorization';
import { safeError } from './config';
import { ResearchPersistenceError } from './repository-errors';

export function assertResearchMutation(request: Request) {
    const origin = request.headers.get('origin');
    const host = request.headers.get('host') || new URL(request.url).host;
    if (request.headers.get('sec-fetch-site') === 'cross-site' || (origin && new URL(origin).host !== host)) throw new AuthorizationError('CROSS_ORIGIN', 403, '请求必须来自同源页面');
}
export function researchError(error: unknown) {
  const message = safeError(error);
  const status = error instanceof AuthorizationError ? error.status : error instanceof ZodError || error instanceof SyntaxError ? 400
    : error instanceof ResearchPersistenceError ? error.code === 'NOT_FOUND' ? 404 : error.code === 'INVALID_RESEARCH' ? 400 : 409
    : message === 'IDEMPOTENCY_CONFLICT' ? 409 : 502;
  return NextResponse.json({ error: error instanceof ZodError || error instanceof SyntaxError ? '请求参数无效' : message }, { status, headers: { 'Cache-Control': 'private, no-store' } });
}
