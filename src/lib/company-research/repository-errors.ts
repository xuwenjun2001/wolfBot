export class ResearchPersistenceError extends Error {
  constructor(public readonly code: 'NOT_FOUND' | 'IDEMPOTENCY_CONFLICT' | 'REVISION_CONFLICT' | 'TASK_ACTIVE' | 'LEASE_LOST' | 'BUDGET_EXHAUSTED' | 'INVALID_RESEARCH', message: string = code) { super(message); }
}
