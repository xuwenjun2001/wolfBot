import { describe, expect, it } from 'vitest';
import {
  ACTIVE_REQUESTS_INVALID_RESPONSE_ERROR,
  ACTIVE_REQUESTS_NETWORK_ERROR,
  createActiveRequestsState,
  createUnavailableActiveRequestsState,
  getActiveRequestsHttpErrorMessage,
  parseActiveRequestsResponse,
} from './useUserRequests';

describe('useUserRequests active request state', () => {
  it('keeps the successful response semantics for empty and active responses', () => {
    expect(parseActiveRequestsResponse({ hasActiveRequests: false, activeCount: 0 })).toEqual({
      hasActiveRequests: false,
      activeCount: 0,
    });
    expect(createActiveRequestsState({ hasActiveRequests: false, activeCount: 0 })).toEqual({
      hasActiveRequests: false,
      activeCount: 0,
      activeRequestsAvailable: true,
      activeRequestsError: null,
    });
    expect(createActiveRequestsState({ hasActiveRequests: true, activeCount: 2 })).toEqual({
      hasActiveRequests: true,
      activeCount: 2,
      activeRequestsAvailable: true,
      activeRequestsError: null,
    });
  });

  it.each([
    ['404', getActiveRequestsHttpErrorMessage(404)],
    ['non-2xx', getActiveRequestsHttpErrorMessage(503)],
    ['network', ACTIVE_REQUESTS_NETWORK_ERROR],
  ])('fails closed for %s failures without erasing the last known activity', (_name, errorMessage) => {
    const lastKnownState = createActiveRequestsState({
      hasActiveRequests: true,
      activeCount: 1,
    });

    expect(createUnavailableActiveRequestsState(lastKnownState, errorMessage)).toEqual({
      hasActiveRequests: true,
      activeCount: 1,
      activeRequestsAvailable: false,
      activeRequestsError: errorMessage,
    });
  });

  it.each([
    ['empty object', {}],
    ['null', null],
    ['array', []],
    ['invalid hasActiveRequests', { hasActiveRequests: 'false', activeCount: 0 }],
    ['negative activeCount', { hasActiveRequests: false, activeCount: -1 }],
    ['NaN activeCount', { hasActiveRequests: false, activeCount: Number.NaN }],
    ['infinite activeCount', { hasActiveRequests: false, activeCount: Number.POSITIVE_INFINITY }],
  ])('rejects malformed 200 response: %s', (_name, payload) => {
    expect(parseActiveRequestsResponse(payload)).toBeNull();
  });

  it('recovers availability and clears the error on the next successful response', () => {
    const unavailableState = createUnavailableActiveRequestsState(
      createActiveRequestsState({ hasActiveRequests: false, activeCount: 0 }),
      ACTIVE_REQUESTS_INVALID_RESPONSE_ERROR,
    );

    expect(createActiveRequestsState({ hasActiveRequests: false, activeCount: 0 })).toEqual({
      ...unavailableState,
      activeRequestsAvailable: true,
      activeRequestsError: null,
    });
  });
});
