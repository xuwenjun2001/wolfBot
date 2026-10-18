import { requireAction } from '@/lib/auth/action';
import { NextResponse } from 'next/server';
import { researchError } from '@/lib/company-research/http';
import { eventsAfter, getRun, publicRun } from '@/lib/company-research/store';
import { terminalStatuses } from '@/lib/company-research/contracts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = (await requireAction({ headers: request.headers, action: 'research.report.read' })).actorUserId, { id } = await context.params;
    const initial = await getRun(actor, id);
    if (!initial) return NextResponse.json({ error: '研究任务不存在' }, { status: 404 });
    let cursor = Number(request.headers.get('last-event-id') || new URL(request.url).searchParams.get('after') || 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
    let stopped = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (value: string) => { if (!stopped && !request.signal.aborted) controller.enqueue(encoder.encode(value)); };
        try {
          // Initial snapshot covers queued/cancelled tasks that have no worker events yet.
          if (cursor === 0) {
            cursor = initial.sequence;
            send(`id: ${cursor}\nevent: snapshot\ndata: ${JSON.stringify(publicRun(initial))}\n\n`);
          }
          while (!stopped && !request.signal.aborted) {
            const events = await eventsAfter(actor, id, cursor);
            for (const event of events) { send(`id: ${event.sequence}\nevent: snapshot\ndata: ${JSON.stringify(event.payload)}\n\n`); cursor = event.sequence; }
            const latest = await getRun(actor, id);
            if (!latest) break;
            if (terminalStatuses.includes(latest.status) && cursor >= latest.sequence) {
              send(`event: snapshot\ndata: ${JSON.stringify(publicRun(latest))}\n\n`); break;
            }
            send(': heartbeat\n\n');
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        } catch { send('event: unavailable\ndata: {}\n\n'); }
        finally { if (!stopped) { stopped = true; controller.close(); } }
      },
      cancel() { stopped = true; },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'private, no-store, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' } });
  } catch (error) { return researchError(error); }
}
