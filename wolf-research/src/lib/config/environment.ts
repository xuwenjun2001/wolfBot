import { z } from 'zod';

const fixedDisabled = z.literal('disabled');
const booleanFlag = z.enum(['0', '1']);

export const runtimeEnvironmentSchema = z.object({
  DATABASE_URL: z.string().min(1),
  WOLF_RESEARCH_MARKET_DATA_URL: z.url(),
  WOLF_RESEARCH_AUTH_MODE: fixedDisabled,
  WOLF_RESEARCH_QUOTA_MODE: fixedDisabled,
  WOLF_RESEARCH_MEMORY_MODE: fixedDisabled,
  WOLF_RESEARCH_KNOWLEDGE_MODE: fixedDisabled,
  WOLF_RESEARCH_ALLOW_UNSANDBOXED_GENERATED_CODE: booleanFlag.default('0'),
  WOLF_RESEARCH_ALLOW_LOOPBACK_MUTATIONS: booleanFlag.default('0'),
});

export type RuntimeEnvironment = z.infer<typeof runtimeEnvironmentSchema>;

export function parseRuntimeEnvironment(
  input: Readonly<Record<string, string | undefined>>,
): RuntimeEnvironment {
  return runtimeEnvironmentSchema.parse(input);
}
