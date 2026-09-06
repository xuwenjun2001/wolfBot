import { ZodError } from 'zod';

import { parseRuntimeEnvironment } from '@/lib/config/environment';
import type { StartupIssue, StartupReport } from '@/lib/ports/startup';

function issueFromZod(error: ZodError): StartupIssue[] {
  return error.issues.map((issue) => ({
    code: 'STARTUP_CONFIGURATION_INVALID',
    variable: issue.path[0] ? String(issue.path[0]) : undefined,
    message: issue.message,
  }));
}

export function runStartupPreflight(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): StartupReport {
  try {
    const config = parseRuntimeEnvironment(environment);
    const marketUrl = new URL(config.WOLF_RESEARCH_MARKET_DATA_URL);
    const issues: StartupIssue[] = [];

    if (!['http:', 'https:'].includes(marketUrl.protocol)) {
      issues.push({
        code: 'MARKET_URL_PROTOCOL_DENIED',
        variable: 'WOLF_RESEARCH_MARKET_DATA_URL',
        message: 'Market data URL must use http or https.',
      });
    }

    return {
      ok: issues.length === 0,
      authMode: 'disabled',
      quotaMode: 'disabled',
      memoryMode: 'disabled',
      knowledgeMode: 'disabled',
      previewEnabled:
        config.WOLF_RESEARCH_ALLOW_UNSANDBOXED_GENERATED_CODE === '1',
      loopbackMutationsEnabled:
        config.WOLF_RESEARCH_ALLOW_LOOPBACK_MUTATIONS === '1',
      sandboxMode: 'windows-unsandboxed',
      issues,
    };
  } catch (error) {
    return {
      ok: false,
      authMode: 'disabled',
      quotaMode: 'disabled',
      memoryMode: 'disabled',
      knowledgeMode: 'disabled',
      previewEnabled: false,
      loopbackMutationsEnabled: false,
      sandboxMode: 'windows-unsandboxed',
      issues:
        error instanceof ZodError
          ? issueFromZod(error)
          : [
              {
                code: 'STARTUP_PREFLIGHT_FAILED',
                message:
                  error instanceof Error ? error.message : 'Unknown preflight failure.',
              },
            ],
    };
  }
}
