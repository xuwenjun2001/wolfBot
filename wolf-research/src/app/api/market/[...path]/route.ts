import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const MARKET_DATA_ORIGIN = (
  process.env.WOLF_RESEARCH_MARKET_DATA_URL?.trim() || 'http://127.0.0.1:8001'
).replace(/\/$/, '');

function buildTarget(request: NextRequest, segments: string[]): URL {
  const normalizedSegments =
    segments[0] === 'api' && segments[1] === 'v1' ? segments.slice(2) : segments;
  const target = new URL(
    `/api/v1/${normalizedSegments.map((segment) => encodeURIComponent(segment)).join('/')}`,
    MARKET_DATA_ORIGIN,
  );
  new URL(request.url).searchParams.forEach((value, key) => {
    target.searchParams.append(key, value);
  });
  return target;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const correlationId = request.headers.get('x-request-id') || randomUUID();
  try {
    const response = await fetch(buildTarget(request, path), {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    const body = await response.arrayBuffer();
    return new NextResponse(body, {
      status: response.status,
      headers: {
        'cache-control': 'no-store',
        'content-type': response.headers.get('content-type') || 'application/json; charset=utf-8',
        'x-request-id': correlationId,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: 'MARKET_UNAVAILABLE',
        message: error instanceof Error ? `市场数据服务不可用：${error.message}` : '市场数据服务不可用。',
        correlationId,
        retryable: true,
      },
      { status: 503, headers: { 'cache-control': 'no-store', 'x-request-id': correlationId } },
    );
  }
}
