export interface OperationContext {
  correlationId: string;
  actorId: string | null;
  projectId?: string;
  requestId?: string;
  idempotencyKey?: string;
  deadlineAt?: string;
  signal?: AbortSignal;
}
