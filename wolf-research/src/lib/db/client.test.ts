import { describe, expect, it } from 'vitest';

import { PRISMA_CLIENT_CONTRACT, prisma } from './client';

describe('Prisma client singleton contract', () => {
  it('uses only the Wolf Research PI schema contract', () => {
    expect(PRISMA_CLIENT_CONTRACT).toContain('wolf-research-v1');
    expect(PRISMA_CLIENT_CONTRACT).not.toMatch(/auth|quota|knowledge/i);
    expect(prisma).toBeDefined();
  });
});
