import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteProjectWithOwnedQuota, PROJECTS_OWNED_WINDOW } from './allocation-reconciliation';

const databaseUrl = process.env.PI_AGENT_TEST_DATABASE_URL?.trim();

// Every fixture is created inside an uncommitted transaction that ALWAYS rolls
// back, even after a successful test. No existing row is selected for deletion.
describe.skipIf(!databaseUrl)('project deletion (PostgreSQL constraints and quotas)', () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = new PrismaClient({ datasourceUrl: databaseUrl! });
    await db.$connect();
  });
  afterAll(async () => { await db?.$disconnect(); });

  async function withFixture(test: (tx: Prisma.TransactionClient, id: string) => Promise<void>) {
    const rollback = new Error('Rollback disposable project deletion fixture');
    try {
      await db.$transaction(async (tx) => {
        await test(tx, `delete-test-${randomUUID()}`);
        throw rollback;
      }, { timeout: 30_000 });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }

  // Run the production transaction callback under a savepoint so both success
  // and rollback can be inspected without ever committing the outer fixture.
  function fixtureClient(tx: Prisma.TransactionClient) {
    return {
      $transaction: async (callback: (transaction: Prisma.TransactionClient) => Promise<unknown>) => {
        await tx.$executeRaw`SAVEPOINT deletion_under_test`;
        try {
          const result = await callback(tx);
          await tx.$executeRaw`RELEASE SAVEPOINT deletion_under_test`;
          return result;
        } catch (error) {
          await tx.$executeRaw`ROLLBACK TO SAVEPOINT deletion_under_test`;
          throw error;
        }
      },
    } as Pick<PrismaClient, '$transaction'>;
  }

  async function ownedProjects(tx: Prisma.TransactionClient, id: string) {
    const ownerId = `${id}-owner`;
    await tx.authUser.create({ data: { id: ownerId, name: 'Deletion fixture', email: `${id}@example.invalid` } });
    const project = await tx.project.create({ data: { id, name: 'Disposable deletion fixture', ownerId } });
    await tx.project.create({ data: { id: `${id}-keep`, name: 'Untouched fixture', ownerId } });
    const bucket = await tx.usageBucket.create({ data: {
      actorUserId: ownerId, metric: 'projects.owned', used: 2n,
      windowStart: PROJECTS_OWNED_WINDOW.start, windowEnd: PROJECTS_OWNED_WINDOW.end,
    } });
    return { project, ownerId, bucket };
  }

  it('cascades a complete agent graph, retains quota history, and decrements only once', async () => {
    await withFixture(async (tx, id) => {
      const { ownerId, bucket } = await ownedProjects(tx, id);
      const request = await tx.userRequest.create({ data: { id: `${id}-request`, projectId: id, instruction: 'Fixture' } });
      const run = await tx.agentRun.create({ data: {
        id: `${id}-run`, projectId: id, requestId: request.id,
        workspaceKey: `sha256:${'a'.repeat(64)}`, provider: 'test', model: 'test',
        frameworkVersion: 'test', buildRevision: 'test', profileHash: 'test',
        promptHash: 'test', toolHash: 'test', skillHash: 'test', workspaceHash: 'test',
      } });
      const event = await tx.agentEvent.create({ data: {
        eventId: `${id}-event`, runId: run.id, sequence: 1, eventType: 'fixture', payload: {}, occurredAt: new Date(),
      } });
      const mission = await tx.agentMission.create({ data: {
        id: `${id}-mission`, projectId: id, requestId: request.id, spec: {}, specHash: 'test',
      } });
      const receipt = await tx.agentEvidenceReceipt.create({ data: {
        id: `${id}-receipt`, missionId: mission.id, candidateVersion: 0, receiptType: 'acceptance',
        verdict: 'accepted', subjectHash: 'test', receiptHash: id, payload: {},
      } });
      await tx.agentMission.update({ where: { id: mission.id }, data: { acceptedReceiptId: receipt.id } });
      await tx.agentGenerationLease.create({ data: {
        projectId: id, activeRequestId: request.id, status: 'held', leaseOwner: id,
        leaseExpiresAt: new Date(Date.now() + 60_000), operationId: id, stage: 'agent_execution',
      } });
      const job = await tx.agentGenerationJob.create({ data: {
        projectId: id, requestId: request.id, executionEnvelope: {}, instructionHash: 'test', instructionPreview: 'test',
      } });
      const outbox = await tx.agentGenerationOutboxEvent.create({ data: {
        jobId: job.id, projectId: id, requestId: request.id, sequence: 1,
        eventType: 'fixture', payload: {}, occurredAt: new Date(),
      } });
      const reservation = await tx.quotaReservation.create({ data: {
        idempotencyKey: id, actorUserId: ownerId, projectId: id, bucketId: bucket.id, metric: 'projects.owned',
        reservedQuantity: 1n, committedQuantity: 1n, status: 'settled', policyEnforcement: 'hard',
        policyWindowType: 'lifetime', expiresAt: new Date(), settledAt: new Date(),
      } });
      const usage = await tx.usageEvent.create({ data: {
        idempotencyKey: `${id}-created`, actorUserId: ownerId, projectId: id, reservationId: reservation.id,
        bucketId: bucket.id, metric: 'projects.owned', quantity: 1n, sourceType: 'project', sourceId: id,
        occurredAt: new Date(),
      } });

      const client = fixtureClient(tx);
      await expect(deleteProjectWithOwnedQuota(client, id, { deletedByUserId: ownerId }))
        .resolves.toMatchObject({ id, quotaAdjusted: true });
      await expect(deleteProjectWithOwnedQuota(client, id)).resolves.toBeNull();

      expect(await tx.project.findUnique({ where: { id } })).toBeNull();
      expect(await tx.project.findUnique({ where: { id: `${id}-keep` } })).not.toBeNull();
      expect(await tx.userRequest.findUnique({ where: { id: request.id } })).toBeNull();
      expect(await tx.agentRun.findUnique({ where: { id: run.id } })).toBeNull();
      expect(await tx.agentEvent.findUnique({ where: { id: event.id } })).toBeNull();
      expect(await tx.agentMission.findUnique({ where: { id: mission.id } })).toBeNull();
      expect(await tx.agentEvidenceReceipt.findUnique({ where: { id: receipt.id } })).toBeNull();
      expect(await tx.agentGenerationLease.findUnique({ where: { projectId: id } })).toBeNull();
      expect(await tx.agentGenerationJob.findUnique({ where: { id: job.id } })).toBeNull();
      expect(await tx.agentGenerationOutboxEvent.findUnique({ where: { id: outbox.id } })).toBeNull();
      expect(await tx.usageBucket.findUnique({ where: { id: bucket.id } })).toMatchObject({ used: 1n });
      expect(await tx.quotaReservation.findUnique({ where: { id: reservation.id } }))
        .toMatchObject({ projectId: null, status: 'settled' });
      expect(await tx.usageEvent.findUnique({ where: { id: usage.id } }))
        .toMatchObject({ projectId: null, quantity: 1n, sourceId: id });
      const adjustments = await tx.usageEvent.findMany({ where: { actorUserId: ownerId, sourceType: 'project_deleted' } });
      expect(adjustments).toHaveLength(1);
      expect(adjustments[0]).toMatchObject({ quantity: -1n, metadata: { transactional: true, deletedByUserId: ownerId } });
    });
  });

  it('rolls back both project deletion and allocation if writing the usage event fails', async () => {
    await withFixture(async (tx, id) => {
      const { project, ownerId, bucket } = await ownedProjects(tx, id);
      // Deliberately collide only with this fixture's event key, exercising an
      // actual database constraint failure after the DELETE and gauge update.
      await tx.usageEvent.create({ data: {
        idempotencyKey: `project-delete:${id}:${project.createdAt.getTime()}:owned-adjustment`,
        actorUserId: ownerId, bucketId: bucket.id, metric: 'projects.owned', quantity: 0n,
        sourceType: 'fixture', occurredAt: new Date(),
      } });

      await expect(deleteProjectWithOwnedQuota(fixtureClient(tx), id)).rejects.toMatchObject({ code: 'P2002' });
      expect(await tx.project.findUnique({ where: { id } })).not.toBeNull();
      expect(await tx.usageBucket.findUnique({ where: { id: bucket.id } })).toMatchObject({ used: 2n });
      expect(await tx.usageEvent.count({ where: { actorUserId: ownerId, sourceType: 'project_deleted' } })).toBe(0);
    });
  });

  it('deletes an ownerless project without requiring quota records', async () => {
    await withFixture(async (tx, id) => {
      await tx.project.create({ data: { id, name: 'Disposable ownerless fixture' } });
      await expect(deleteProjectWithOwnedQuota(fixtureClient(tx), id))
        .resolves.toMatchObject({ id, ownerId: null, quotaAdjusted: false, usageEventId: null });
      expect(await tx.project.findUnique({ where: { id } })).toBeNull();
    });
  });
});
