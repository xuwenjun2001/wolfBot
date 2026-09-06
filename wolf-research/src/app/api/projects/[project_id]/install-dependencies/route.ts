import { NextResponse } from 'next/server';

import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { projectRouteAction } from '@/lib/auth/project-route-action';
import { getProjectById } from '@/lib/services/project';
import { previewManager } from '@/lib/services/preview';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function POST(
  request: Request,
  { params }: RouteContext,
): Promise<NextResponse> {
  const { project_id } = await params;
  try {
    await requireAction({
      headers: request.headers,
      action: projectRouteAction('install-dependencies', request.method),
      projectId: project_id,
    });

    if (!(await getProjectById(project_id))) {
      return NextResponse.json(
        { success: false, error: 'PROJECT_NOT_FOUND', message: 'Project not found' },
        { status: 404 },
      );
    }

    const result = await previewManager.installDependencies(project_id);
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return authErrorResponse(error);
    }
    if (error instanceof Error && error.message === 'Project not found') {
      return NextResponse.json(
        { success: false, error: 'PROJECT_NOT_FOUND', message: 'Project not found' },
        { status: 404 },
      );
    }

    console.error('[API] Failed to install project dependencies:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'PREVIEW_INSTALL_FAILED',
        message: 'Project dependency installation failed.',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
