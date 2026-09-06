export type ProjectRole = 'owner' | 'editor' | 'viewer';

export class AuthorizationError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 401 | 403 | 404 | 428,
    message: string,
  ) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export function projectIdFromPath(pathname: string): string | null {
  const apiMatch = pathname.match(/^\/api\/(?:assets|chat|env|projects|repo|ws)\/([^/]+)/);
  const pageMatch = pathname.match(/^\/([^/]+)\/chat(?:\/|$)/);
  const encoded = apiMatch?.[1] ?? pageMatch?.[1];
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}
