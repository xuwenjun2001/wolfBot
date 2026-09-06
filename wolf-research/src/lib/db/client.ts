import { PrismaClient } from '@prisma/client';

import { PI_AGENT_SCHEMA_CONTRACT_VERSION } from './pi-agent-schema-readiness';

const PRISMA_CLIENT_CONTRACT = `${PI_AGENT_SCHEMA_CONTRACT_VERSION}:wolf-research-v1`;
const globalForPrisma = globalThis as unknown as {
  wolfResearchPrisma?: PrismaClient;
  wolfResearchPrismaContract?: string;
};

const reusable =
  globalForPrisma.wolfResearchPrismaContract === PRISMA_CLIENT_CONTRACT
    ? globalForPrisma.wolfResearchPrisma
    : undefined;

export const prisma = reusable ?? new PrismaClient({
  log:
    process.env.NODE_ENV === 'development' && process.env.WOLF_RESEARCH_PRISMA_QUERY_LOG === '1'
      ? ['query', 'error', 'warn']
      : ['error', 'warn'],
});

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.wolfResearchPrisma = prisma;
  globalForPrisma.wolfResearchPrismaContract = PRISMA_CLIENT_CONTRACT;
}

export { PRISMA_CLIENT_CONTRACT };
