export interface ServiceErrorPayload {
  code: string;
  message: string;
  service: string;
  operation: string;
  correlationId: string;
  retryable: boolean;
  httpStatus?: number;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
}

export class ServiceError extends Error {
  readonly payload: ServiceErrorPayload;

  constructor(payload: ServiceErrorPayload, options?: ErrorOptions) {
    super(payload.message, options);
    this.name = 'ServiceError';
    this.payload = payload;
  }
}
