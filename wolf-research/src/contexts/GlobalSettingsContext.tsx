"use client";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getDefaultModelForCli, normalizeModelId } from '@/lib/constants/models';
import {
  PRODUCT_CLI_ID,
  normalizeProductCliIdOrDefault,
} from '@/lib/constants/cli';

export type GlobalAISettings = {
  default_cli: typeof PRODUCT_CLI_ID;
  cli_settings: {
    pi: {
      model?: string;
    };
  };
};

type GlobalSettingsCtx = {
  settings: GlobalAISettings;
  setSettings: React.Dispatch<React.SetStateAction<GlobalAISettings>>;
  error: Error | null;
  refresh: () => Promise<void>;
};

const defaultSettings: GlobalAISettings = {
  default_cli: PRODUCT_CLI_ID,
  cli_settings: {
    pi: { model: getDefaultModelForCli(PRODUCT_CLI_ID) },
  },
};

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function normalizeGlobalAISettings(value: unknown): GlobalAISettings {
  const root = objectRecord(value);
  const cliSettings = objectRecord(root?.cli_settings ?? root?.cliSettings);
  const piSettings = objectRecord(cliSettings?.pi);
  const model = typeof piSettings?.model === 'string'
    ? normalizeModelId(PRODUCT_CLI_ID, piSettings.model)
    : getDefaultModelForCli(PRODUCT_CLI_ID);

  return {
    default_cli: normalizeProductCliIdOrDefault(root?.default_cli ?? root?.defaultCli),
    cli_settings: {
      pi: { model },
    },
  };
}

const Ctx = createContext<GlobalSettingsCtx | null>(null);

export function useGlobalSettings() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useGlobalSettings must be used within GlobalSettingsProvider');
  return ctx;
}

export default function GlobalSettingsProvider({ children }: { children: React.ReactNode }) {
  const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';
  const [settings, setSettings] = useState<GlobalAISettings>(defaultSettings);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/settings/global`);
      if (!res.ok) {
        throw new Error(`Global settings request failed with HTTP ${res.status}.`);
      }
      const s = await res.json();
      setSettings(normalizeGlobalAISettings(s));
      setError(null);
    } catch (cause) {
      const nextError = cause instanceof Error ? cause : new Error(String(cause));
      setError(nextError);
      console.error('Failed to refresh global settings:', nextError);
    }
  }, [API_BASE]);

  // Load once on mount
  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ settings, setSettings, error, refresh }),
    [settings, error, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
