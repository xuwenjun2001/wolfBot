/**
 * Project collection API.
 * GET /api/projects - list local-system projects
 * POST /api/projects - create a project and provision its workspace
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { DEFAULT_DATA_AGENT_PROFILE_ID } from '@/lib/config/data-agent';
import { PRODUCT_CLI_ID } from '@/lib/constants/cli';
import { normalizePiAgentModelId } from '@/lib/constants/models';
import { getAllProjects, createProject } from '@/lib/services/project';
import {
  ApiIdempotencyConflictError,
  claimApiOperation,
  completeApiOperation,
  failApiOperation,
  isExplicitIdempotencyKey,
  normalizeIdempotencyKey,
  type ApiOperationHandle,
} from '@/lib/server/api-idempotency';
import { serializeProjects, serializeProject } from '@/lib/serializers/project';
import type { CreateProjectInput } from '@/types/backend';
import { createErrorResponse, createSuccessResponse, handleApiError } from '@/lib/utils/api-response';

const createProjectRequestSchema = z.object({
  projectId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
  name: z.string().trim().min(1).max(120),
  initialPrompt: z.string().trim().max(200_000).optional(),
  selectedModel: z.string().trim().min(1).max(256).optional(),
  description: z.string().trim().max(20_000).nullable().optional(),
  capabilityId: z.string().trim().min(1).max(128).optional(),
  capabilitySelectionSource: z.enum(['manual', 'default', 'inferred']).optional(),
  agentProfileId: z.string().trim().regex(/^[a-z][a-z0-9._-]{1,127}$/).optional(),
}).strict();

function idempotencyStateResponse(code: string, message: string, retryAfter?: number): NextResponse {
  return NextResponse.json(
    { success: false, error: { code, message, retryable: code === 'IDEMPOTENCY_IN_PROGRESS' } },
    {
      status: 409,
      ...(retryAfter ? { headers: { 'Retry-After': String(Math.min(30, retryAfter)) } } : {}),
    },
  );
}

export async function GET(request: NextRequest) {
  try {
    await requireAction({ headers: request.headers, action: 'project.read' });
    return createSuccessResponse(serializeProjects(await getAllProjects()));
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error) as NextResponse;
    return handleApiError(error, 'API', 'Failed to fetch projects');
  }
}

export async function POST(request: NextRequest) {
  let operationHandle: ApiOperationHandle | null = null;
  try {
    const actionContext = await requireAction({ headers: request.headers, action: 'project.create' });
    const rawBody = await request.json().catch(() => null);
    const parsed = createProjectRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return createErrorResponse('INVALID_PROJECT_REQUEST', '项目创建请求必须使用当前 camelCase 合同。', 400);
    }
    const body = parsed.data;
    const input: CreateProjectInput = {
      project_id: body.projectId,
      name: body.name,
      initialPrompt: body.initialPrompt ?? '',
      preferredCli: PRODUCT_CLI_ID,
      selectedModel: normalizePiAgentModelId(body.selectedModel),
      description: body.description ?? undefined,
      capabilityId: body.capabilityId,
      capabilitySelectionSource: body.capabilitySelectionSource,
      agentProfileId: body.agentProfileId ?? DEFAULT_DATA_AGENT_PROFILE_ID,
    };

    const suppliedKey = request.headers.get('idempotency-key');
    const key = isExplicitIdempotencyKey(suppliedKey) ? suppliedKey : body.projectId;
    const operation = await claimApiOperation({
      scope: 'project-create',
      actorKey: actionContext.actorUserId,
      idempotencyKey: normalizeIdempotencyKey(key),
      payload: input,
      leaseSeconds: 10 * 60,
    });
    if (operation.state === 'in_progress') {
      return idempotencyStateResponse('IDEMPOTENCY_IN_PROGRESS', '相同项目创建操作正在执行，请稍后重试。', operation.retryAfterSeconds);
    }
    if (operation.state === 'completed') {
      if (operation.responseBody === null || !operation.responseAvailable) {
        return idempotencyStateResponse('IDEMPOTENCY_RESULT_UNAVAILABLE', '项目已创建但原响应不可用，请读取项目列表确认结果。');
      }
      return NextResponse.json(operation.responseBody, {
        status: operation.responseStatus,
        headers: { 'Idempotency-Replayed': 'true' },
      });
    }
    operationHandle = operation.handle;

    const project = await createProject(input, { ownerId: actionContext.actorUserId });
    const responseBody = { success: true, data: serializeProject(project) };
    await completeApiOperation({
      handle: operationHandle,
      responseStatus: 201,
      responseBody,
    });
    return NextResponse.json(responseBody, { status: 201 });
  } catch (error) {
    if (operationHandle) {
      await failApiOperation({ handle: operationHandle, error }).catch((persistError) => {
        console.error('[Idempotency] Failed to persist project creation failure:', persistError);
      });
    }
    if (error instanceof ApiIdempotencyConflictError) {
      return idempotencyStateResponse(error.code, error.message);
    }
    if (error instanceof AuthorizationError) return authErrorResponse(error) as NextResponse;
    if (error instanceof Error && error.message.includes('API idempotency')) {
      return createErrorResponse('IDEMPOTENCY_COMMIT_FAILED', '项目已处理，但暂时无法安全保存幂等结果。', 503);
    }
    return handleApiError(error, 'API', 'Failed to create project');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
