import fs from 'node:fs/promises';
import path from 'node:path';

export const AKEP_PROTOCOL = 'akep' as const;
export const AKEP_VERSION = '0.1' as const;

export interface KnowledgeCitation {
  citationId: string;
  chunkId: string;
  payloadDigest: string;
  locator: Record<string, unknown>;
  quote: string;
  recordId: string;
  revisionId: string;
  spaceId: string;
}

export type KnowledgeQualityDecision = 'suitable' | 'suitable_with_warning' | 'insufficient';

export interface GovernedKnowledgeCapsule {
  content: string;
  contextPackId: string;
  contextDigest: string;
  exposureReceiptId: string;
  policyEpoch: string;
  purpose: string;
  citations: KnowledgeCitation[];
  obligations: unknown[];
  qualityDecision: KnowledgeQualityDecision;
  warningCodes: string[];
  integrationScopeSha256: string;
  consumerId: string;
  requestedSpaceIds: string[];
  projectSpaceId: string | null;
}

export type GovernedKnowledgeStatus = 'disabled' | 'unavailable' | 'empty' | 'prepared';

export interface GovernedKnowledgePreparation {
  status: GovernedKnowledgeStatus;
  capsule: GovernedKnowledgeCapsule | null;
  passageCount: number;
  citationCount: number;
  failureCode?: string;
}

export interface KnowledgeUsageReceipt {
  usageId: string;
  exposureReceiptId: string;
  spaceId: string;
  policyEpoch: string;
  createdAt: string;
  feedbackUntil: string;
}

export interface KnowledgeUsageResult {
  status: 'disabled' | 'not_applicable' | 'recorded' | 'unavailable';
  usageReceipts: KnowledgeUsageReceipt[];
  failureCode?: string;
}

function assertDisabledMode(): void {
  if ((process.env.WOLF_RESEARCH_KNOWLEDGE_MODE ?? 'disabled') !== 'disabled') {
    throw new Error(
      'WOLF_RESEARCH_KNOWLEDGE_MODE must be disabled in this release; no external Knowledge adapter is bundled.',
    );
  }
}

export async function prepareGovernedKnowledge(_input?: Record<string, unknown>): Promise<GovernedKnowledgePreparation> {
  assertDisabledMode();
  return { status: 'disabled', capsule: null, passageCount: 0, citationCount: 0 };
}

export async function recordGovernedKnowledgeUsage(input: {
  capsule: GovernedKnowledgeCapsule | null;
  [key: string]: unknown;
}): Promise<KnowledgeUsageResult> {
  assertDisabledMode();
  if (input.capsule) {
    throw new Error('KNOWLEDGE_INTEGRATION_DISABLED: a disabled adapter cannot record usage.');
  }
  return { status: 'disabled', usageReceipts: [] };
}

export async function persistAcceptedGovernedKnowledgeUse(input: {
  capsule: GovernedKnowledgeCapsule | null;
  [key: string]: unknown;
}): Promise<null> {
  assertDisabledMode();
  if (input.capsule) {
    throw new Error('KNOWLEDGE_INTEGRATION_DISABLED: a disabled adapter cannot persist attribution.');
  }
  return null;
}

export async function writeGovernedKnowledgeEvidence(input: {
  projectPath: string;
  requestId: string;
  preparation: GovernedKnowledgePreparation;
  usage?: KnowledgeUsageResult;
}): Promise<void> {
  assertDisabledMode();
  const evidenceDir = path.join(input.projectPath, 'evidence');
  const target = path.join(evidenceDir, 'knowledge-sources.json');
  const temporary = `${target}.${process.pid}.tmp`;
  const document = {
    schemaVersion: 1,
    provider: 'disabled-local',
    requestId: input.requestId,
    status: input.preparation.status,
    passageCount: input.preparation.passageCount,
    citationCount: input.preparation.citationCount,
    ...(input.preparation.failureCode ? { failureCode: input.preparation.failureCode } : {}),
    citations: [],
    ...(input.usage ? { usage: input.usage } : {}),
    recordedAt: new Date().toISOString(),
  };
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.rename(temporary, target);
}
