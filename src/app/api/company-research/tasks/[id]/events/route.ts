import { requireAction } from '@/lib/auth/action';
import { researchError } from '@/lib/company-research/http';
import { getResearchTask, researchVersionEventsAfter } from '@/lib/company-research/version-store';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{id: string}> }) {
  try {
    const actor = (await requireAction({ headers: request.headers, action: 'research.report.read' })).actorUserId, { id } = await context.params;
    const initial = await getResearchTask(actor, id);
    if (!initial) return new Response(null, { status: 404 });
    // Every connection begins at an authoritative snapshot. No gap can survive reconnect.
    let stopped = false, cursor = initial.sequence;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown, sequence?: number) => {
          if (!stopped && !request.signal.aborted) controller.enqueue(encoder.encode(`${sequence === undefined ? '' : `id: ${sequence}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        try {
          send('snapshot', initial, cursor);
          while (!stopped && !request.signal.aborted) {
            const events = await researchVersionEventsAfter(actor, id, cursor);
            for (const event of events) { send('research', event, event.sequence); cursor = event.sequence; }
            const latest = await getResearchTask(actor, id); if (!latest) break;
            // A snapshot repairs dropped events and carries claim/document/report state.
            send('snapshot', latest, latest.sequence); cursor = latest.sequence;
            if (['partial', 'completed', 'failed', 'cancelled'].includes(latest.status)) break;
            await new Promise<void>(resolve => {
              const done = () => { clearTimeout(timer); request.signal.removeEventListener('abort', done); resolve(); };
              const timer = setTimeout(done, 1500); request.signal.addEventListener('abort', done, { once: true });
            });
          }
        } catch { send('unavailable', {}); }
        finally { if (!stopped) { stopped = true; controller.close(); } }
      }, cancel() { stopped = true; },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'private, no-store, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' } });
  } catch (error) { return researchError(error); }
}
