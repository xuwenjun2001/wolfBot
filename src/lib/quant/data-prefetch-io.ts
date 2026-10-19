import fs from 'fs/promises';
import path from 'path';

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

export async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function readJson(filePath: string): Promise<JsonRecord | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return asRecord(JSON.parse(content));
  } catch {
    return null;
  }
}
