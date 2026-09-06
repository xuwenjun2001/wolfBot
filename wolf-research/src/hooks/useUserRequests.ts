import { useState, useCallback, useEffect, useRef } from 'react';

interface UseUserRequestsOptions {
  projectId: string;
}

export interface ActiveRequestsResponse {
  hasActiveRequests: boolean;
  activeCount: number;
}

export interface ActiveRequestsState extends ActiveRequestsResponse {
  activeRequestsAvailable: boolean;
  activeRequestsError: string | null;
}

export const ACTIVE_REQUESTS_NETWORK_ERROR = '活动请求状态查询失败，请稍后重试。';
export const ACTIVE_REQUESTS_INVALID_RESPONSE_ERROR = '活动请求状态响应无效，请稍后重试。';

export function isActiveRequestsResponse(value: unknown): value is ActiveRequestsResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.hasActiveRequests === 'boolean' &&
    typeof record.activeCount === 'number' &&
    Number.isFinite(record.activeCount) &&
    record.activeCount >= 0
  );
}

export function parseActiveRequestsResponse(
  value: unknown,
): ActiveRequestsResponse | null {
  return isActiveRequestsResponse(value) ? value : null;
}

export function createActiveRequestsState(
  response: ActiveRequestsResponse,
): ActiveRequestsState {
  return {
    hasActiveRequests: response.hasActiveRequests,
    activeCount: response.activeCount,
    activeRequestsAvailable: true,
    activeRequestsError: null,
  };
}

export function createUnavailableActiveRequestsState(
  current: ActiveRequestsState,
  errorMessage: string,
): ActiveRequestsState {
  return {
    ...current,
    activeRequestsAvailable: false,
    activeRequestsError: errorMessage,
  };
}

export function getActiveRequestsHttpErrorMessage(status: number): string {
  if (status === 404) {
    return '活动请求状态接口不可用（HTTP 404）。';
  }
  return `活动请求状态查询失败（HTTP ${status}）。`;
}

function createInitialActiveRequestsState(): ActiveRequestsState {
  return {
    hasActiveRequests: false,
    activeCount: 0,
    activeRequestsAvailable: false,
    activeRequestsError: null,
  };
}

export function useUserRequests({ projectId }: UseUserRequestsOptions) {
  const [activeRequestState, setActiveRequestState] = useState<ActiveRequestsState>(
    createInitialActiveRequestsState,
  );
  const {
    hasActiveRequests,
    activeCount,
    activeRequestsAvailable,
    activeRequestsError,
  } = activeRequestState;
  const [isTabVisible, setIsTabVisible] = useState(true); // Default to true

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const previousActiveState = useRef(false);
  const activeRequestIdsRef = useRef<Set<string>>(new Set());
  const lastAvailabilityErrorRef = useRef<string | null>(null);

  const setFromActiveSet = useCallback(() => {
    const size = activeRequestIdsRef.current.size;
    setActiveRequestState((current) => ({
      ...current,
      activeCount: size,
      hasActiveRequests: size > 0,
    }));
  }, []);

  const registerActiveRequest = useCallback((requestId: string | null | undefined) => {
    if (!requestId) return;
    const set = activeRequestIdsRef.current;
    const before = set.size;
    set.add(requestId);
    if (set.size !== before) {
      setFromActiveSet();
    }
  }, [setFromActiveSet]);

  const unregisterActiveRequest = useCallback((requestId: string | null | undefined) => {
    if (!requestId) return;
    const set = activeRequestIdsRef.current;
    if (set.delete(requestId)) {
      setFromActiveSet();
    }
  }, [setFromActiveSet]);

  const markActiveRequestsUnavailable = useCallback((errorMessage: string) => {
    setActiveRequestState((current) =>
      createUnavailableActiveRequestsState(current, errorMessage),
    );
    if (
      process.env.NODE_ENV === 'development' &&
      lastAvailabilityErrorRef.current !== errorMessage
    ) {
      console.warn('[UserRequests] Active request status unavailable:', errorMessage);
    }
    lastAvailabilityErrorRef.current = errorMessage;
  }, []);

  // Track tab visibility state
  useEffect(() => {
    // Execute only on client side
    if (typeof document !== 'undefined') {
      setIsTabVisible(!document.hidden);

      const handleVisibilityChange = () => {
        setIsTabVisible(!document.hidden);
      };

      document.addEventListener('visibilitychange', handleVisibilityChange);
      return () => {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      };
    }
  }, []);

  useEffect(() => {
    activeRequestIdsRef.current.clear();
    previousActiveState.current = false;
    lastAvailabilityErrorRef.current = null;
    setActiveRequestState(createInitialActiveRequestsState());
  }, [projectId]);

  // Query active request status from DB
  const checkActiveRequests = useCallback(async (options?: { force?: boolean }) => {
    if (!options?.force && !isTabVisible) return; // Stop polling if tab is inactive unless forced

    try {
      const apiBase = process.env.NEXT_PUBLIC_API_BASE ?? '';
      const response = await fetch(`${apiBase}/api/chat/${projectId}/requests/active`, {
        cache: 'no-store',
      });
      if (!response.ok) {
        markActiveRequestsUnavailable(
          getActiveRequestsHttpErrorMessage(response.status),
        );
        return;
      }

      const data = parseActiveRequestsResponse(await response.json());
      if (!data) {
        markActiveRequestsUnavailable(ACTIVE_REQUESTS_INVALID_RESPONSE_ERROR);
        return;
      }
      if (!data.hasActiveRequests && activeRequestIdsRef.current.size > 0) {
        activeRequestIdsRef.current.clear();
      }
      setActiveRequestState(createActiveRequestsState(data));
      lastAvailabilityErrorRef.current = null;

      // Log only when active state changes
      if (data.hasActiveRequests !== previousActiveState.current) {
        console.log(`🔄 [UserRequests] Active requests: ${data.hasActiveRequests} (count: ${data.activeCount})`);
        previousActiveState.current = data.hasActiveRequests;
      }
    } catch (error) {
      markActiveRequestsUnavailable(ACTIVE_REQUESTS_NETWORK_ERROR);
      if (process.env.NODE_ENV === 'development') {
        console.warn('[UserRequests] Failed to check active requests:', error);
      }
    }
  }, [projectId, isTabVisible, markActiveRequestsUnavailable]);

  // Adaptive polling configuration
  useEffect(() => {
    // Stop polling if tab is inactive
    if (!isTabVisible) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    // Determine polling interval based on active request status
    const pollInterval = hasActiveRequests ? 500 : 5000; // 0.5s vs 5s

    // Clean up existing polling
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }

    // Check immediately once
    checkActiveRequests();

    // Start new polling
    intervalRef.current = setInterval(() => checkActiveRequests(), pollInterval);

    if (process.env.NODE_ENV === 'development') {
      console.log(`⏱️ [UserRequests] Polling interval: ${pollInterval}ms (active: ${hasActiveRequests}, available: ${activeRequestsAvailable})`);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [hasActiveRequests, isTabVisible, checkActiveRequests, activeRequestsAvailable]);

  // Clean up on component unmount
  useEffect(() => {
    const activeRequestIds = activeRequestIdsRef.current;
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      activeRequestIds.clear();
    };
  }, []);

  const createRequest = useCallback((
    requestId: string,
    messageId: string,
    instruction: string,
    type: 'act' | 'chat' = 'act'
  ) => {
    registerActiveRequest(requestId);
    // Check status immediately via polling
    checkActiveRequests({ force: true });
    console.log(`🔄 [UserRequests] Created request: ${requestId}`);
  }, [checkActiveRequests, registerActiveRequest]);

  const startRequest = useCallback((requestId: string) => {
    registerActiveRequest(requestId);
    // Check status immediately via polling
    checkActiveRequests({ force: true });
    console.log(`▶️ [UserRequests] Started request: ${requestId}`);
  }, [checkActiveRequests, registerActiveRequest]);

  const completeRequest = useCallback((
    requestId: string,
    isSuccessful: boolean,
    errorMessage?: string
  ) => {
    unregisterActiveRequest(requestId);
    // Check status immediately via polling with slight delay
    setTimeout(() => checkActiveRequests({ force: true }), 100);
    console.log(`✅ [UserRequests] Completed request: ${requestId} (${isSuccessful ? 'success' : 'failed'})`);
  }, [checkActiveRequests, unregisterActiveRequest]);

  return {
    hasActiveRequests,
    activeCount,
    activeRequestsAvailable,
    activeRequestsError,
    createRequest,
    startRequest,
    completeRequest,
  };
}
