import fs from 'node:fs/promises';
import path from 'node:path';

import {
  PI_AGENT_DEFAULT_MODEL,
  normalizePiAgentModelId,
} from '@/lib/constants/models';
import { PRODUCT_CLI_ID } from '@/lib/constants/cli';

export type CLISettings = Record<string, Record<string, unknown>>;

export interface GlobalSettings {
  default_cli: typeof PRODUCT_CLI_ID;
  cli_settings: CLISettings;
}

const DEFAULT_SETTINGS: GlobalSettings = {
  default_cli: PRODUCT_CLI_ID,
  cli_settings: {
    [PRODUCT_CLI_ID]: { model: PI_AGENT_DEFAULT_MODEL },
  },
};

function settingsFile(): string {
  return path.resolve(
    process.env.WOLF_RESEARCH_SETTINGS_FILE ??
      path.join(process.cwd(), 'data', 'global-settings.json'),
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function configuredModel(value?: unknown): string {
  const root = record(value);
  const cliSettings = record(root?.cli_settings ?? root?.cliSettings);
  const provider = record(cliSettings?.[PRODUCT_CLI_ID]);
  return normalizePiAgentModelId(
    typeof provider?.model === 'string' ? provider.model : PI_AGENT_DEFAULT_MODEL,
  );
}

function singleProviderSettings(value?: unknown): GlobalSettings {
  return {
    default_cli: PRODUCT_CLI_ID,
    cli_settings: {
      [PRODUCT_CLI_ID]: { model: configuredModel(value) },
    },
  };
}

async function readSettingsFile(): Promise<GlobalSettings | null> {
  try {
    const raw = await fs.readFile(settingsFile(), 'utf8');
    return singleProviderSettings(JSON.parse(raw));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function writeSettings(settings: GlobalSettings): Promise<void> {
  const target = settingsFile();
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function loadGlobalSettings(): Promise<GlobalSettings> {
  return (await readSettingsFile()) ?? DEFAULT_SETTINGS;
}

export function normalizeCliSettings(settings: unknown): CLISettings | undefined {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return undefined;
  }
  return singleProviderSettings({ cli_settings: settings }).cli_settings;
}

export async function updateGlobalSettings(
  partial: Partial<GlobalSettings>,
): Promise<GlobalSettings> {
  const current = await loadGlobalSettings();
  const next = singleProviderSettings({
    ...current,
    ...partial,
    cli_settings: partial.cli_settings ?? current.cli_settings,
  });
  await writeSettings(next);
  return next;
}
