import type { Prisma, PrismaClient } from '@prisma/client';

import { prisma } from '@/lib/db/client';

export type EvalCatalogPayload = Record<string, unknown>;

export class EvalStorageError extends Error {
  readonly code = 'EVAL_STORAGE_UNAVAILABLE';
  readonly status = 503;

  constructor(message = '评测存储不可用，请检查 DATABASE_URL 和 PostgreSQL。', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EvalStorageError';
  }
}

export class EvalCatalogConflictError extends Error {
  readonly code: 'EVAL_CASE_EXISTS' | 'EVAL_SET_EXISTS';
  readonly status = 409;

  constructor(kind: 'case' | 'set', id: string) {
    super(`${kind === 'case' ? '用例' : '评测集'} ID 已存在：${id}`);
    this.name = 'EvalCatalogConflictError';
    this.code = kind === 'case' ? 'EVAL_CASE_EXISTS' : 'EVAL_SET_EXISTS';
  }
}

export interface EvalCatalogRepository {
  listCases(): Promise<EvalCatalogPayload[]>;
  listSets(): Promise<EvalCatalogPayload[]>;
  createCase(id: string, payload: EvalCatalogPayload): Promise<void>;
  createSet(id: string, payload: EvalCatalogPayload): Promise<void>;
}

type EvalCatalogPrismaClient = Pick<PrismaClient, 'evalCase' | 'evalSet'>;

export class PrismaEvalCatalogRepository implements EvalCatalogRepository {
  constructor(private readonly client: EvalCatalogPrismaClient = prisma) {}

  async listCases(): Promise<EvalCatalogPayload[]> {
    try {
      const records = await this.client.evalCase.findMany({ orderBy: { createdAt: 'asc' } });
      return records.map((record) => record.payload as EvalCatalogPayload);
    } catch (error) {
      throw new EvalStorageError('读取自定义评测用例失败。', { cause: error });
    }
  }

  async listSets(): Promise<EvalCatalogPayload[]> {
    try {
      const records = await this.client.evalSet.findMany({ orderBy: { createdAt: 'asc' } });
      return records.map((record) => record.payload as EvalCatalogPayload);
    } catch (error) {
      throw new EvalStorageError('读取自定义评测集失败。', { cause: error });
    }
  }

  async createCase(id: string, payload: EvalCatalogPayload): Promise<void> {
    try {
      await this.client.evalCase.create({ data: { id, payload: toPrismaJson(payload) } });
    } catch (error) {
      if (isPrismaUniqueViolation(error)) throw new EvalCatalogConflictError('case', id);
      throw new EvalStorageError('保存自定义评测用例失败。', { cause: error });
    }
  }

  async createSet(id: string, payload: EvalCatalogPayload): Promise<void> {
    try {
      await this.client.evalSet.create({ data: { id, payload: toPrismaJson(payload) } });
    } catch (error) {
      if (isPrismaUniqueViolation(error)) throw new EvalCatalogConflictError('set', id);
      throw new EvalStorageError('保存自定义评测集失败。', { cause: error });
    }
  }
}

function toPrismaJson(payload: EvalCatalogPayload): Prisma.InputJsonValue {
  try {
    const serialized = JSON.stringify(payload);
    if (!serialized) throw new Error('评测 catalog payload 为空。');
    return JSON.parse(serialized) as Prisma.InputJsonValue;
  } catch (error) {
    throw new EvalStorageError('评测 catalog payload 不是有效 JSON。', { cause: error });
  }
}

function isPrismaUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002');
}

export const evalCatalogRepository: EvalCatalogRepository = new PrismaEvalCatalogRepository();
