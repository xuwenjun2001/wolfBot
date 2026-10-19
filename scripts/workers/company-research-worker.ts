import './worker-environment';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/lib/db/client';
import { claimRun } from '../../src/lib/company-research/store';
import { executeResearch } from '../../src/lib/company-research/runtime';
import { safeError } from '../../src/lib/company-research/config';
import { claimFinancialResearch } from '../../src/lib/company-research/execution-store';
import { executeFinancialResearch } from '../../src/lib/company-research/financial-runtime';

const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());
const once = process.argv.includes('--once');
const owner = `company-research-${randomUUID()}`;
async function main() {
  let financialFirst = true;
  do {
    const financial = financialFirst ? await claimFinancialResearch(owner) : null;
    if (financial) { await executeFinancialResearch(financial.actor, financial.attempt, controller.signal); financialFirst = false; continue; }
    const run = await claimRun(owner);
    if (run) { console.log(`Research ${run.id}: started`); await executeResearch(run, controller.signal); console.log(`Research ${run.id}: checkpoint saved`); }
    else {
      const next = await claimFinancialResearch(owner);
      if (next) await executeFinancialResearch(next.actor, next.attempt, controller.signal);
      else if (!once) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    financialFirst = !financialFirst;
  } while (!once && !controller.signal.aborted);
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; }).finally(() => prisma.$disconnect());
