import { loadEnvConfig } from '@next/env';

import { runStartupPreflight } from '../../src/lib/startup/preflight';

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');

const report = runStartupPreflight();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (!report.ok) {
  process.exitCode = 1;
}
