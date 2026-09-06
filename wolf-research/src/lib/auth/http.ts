import { NextResponse } from 'next/server';

import { AuthorizationError } from './authorization';

export function authErrorResponse(error: unknown): NextResponse {
  if (!(error instanceof AuthorizationError)) {
    throw error;
  }

  return NextResponse.json(
    { success: false, error: error.code, message: error.message },
    { status: error.status },
  );
}
