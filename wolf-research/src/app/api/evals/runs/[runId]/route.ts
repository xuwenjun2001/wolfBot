import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { getQuantEvalRun } from '@/lib/eval';

function errorStatus(error: unknown, fallback: number): number {
  if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') {
    return error.status;
  }
  return fallback;
}

function errorBody(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
  return {
    success: false,
    error: code ?? (error instanceof Error ? error.message : String(error)),
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> }
) {
  try {
    await requireAction({
      headers: request.headers,
      action: 'platform.observability.read',
    });
    const { runId } = await context.params;
    const run = await getQuantEvalRun(runId);
    if (!run) {
      return NextResponse.json(
        {
          success: false,
          error: '未找到评测运行记录。',
        },
        { status: 404 }
      );
    }

    const response = NextResponse.json({ success: true, data: run });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    return NextResponse.json(errorBody(error), { status: errorStatus(error, 500) });
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
