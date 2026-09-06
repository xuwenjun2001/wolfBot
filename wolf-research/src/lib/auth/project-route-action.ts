import type { PermissionAction } from './permissions';

export type ProjectRouteResource =
  | 'project'
  | 'source'
  | 'artifact'
  | 'asset'
  | 'install-dependencies'
  | 'agent-cancel'
  | 'chat-data';

export function projectRouteAction(resource: ProjectRouteResource, method: string): PermissionAction {
  const normalizedMethod = method.toUpperCase();
  const readOnly = normalizedMethod === 'GET' || normalizedMethod === 'HEAD';
  switch (resource) {
    case 'project':
      return readOnly ? 'project.read' : normalizedMethod === 'DELETE' ? 'project.delete' : 'project.update';
    case 'source':
    case 'artifact':
    case 'asset':
      return readOnly ? 'project.source.read' : 'project.source.write';
    case 'install-dependencies':
      return 'project.source.write';
    case 'agent-cancel':
      return 'agent.cancel';
    case 'chat-data':
      return readOnly ? 'project.read' : 'project.update';
  }
}
