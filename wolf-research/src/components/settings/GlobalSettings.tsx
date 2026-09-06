'use client';

import { useEffect, useState } from 'react';
import { Save, Settings, X } from 'lucide-react';

import { useGlobalSettings } from '@/contexts/GlobalSettingsContext';
import { getModelDefinitionsForCli, normalizeModelId } from '@/lib/constants/models';
import { PRODUCT_CLI_ID } from '@/lib/constants/cli';

interface GlobalSettingsProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function GlobalSettings({ isOpen, onClose }: GlobalSettingsProps) {
  const { settings, setSettings, error, refresh } = useGlobalSettings();
  const [model, setModel] = useState(settings.cli_settings.pi?.model ?? '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setModel(settings.cli_settings.pi?.model ?? '');
      setSaveError(null);
      setSaved(false);
    }
  }, [isOpen, settings.cli_settings.pi]);

  if (!isOpen) return null;

  const models = getModelDefinitionsForCli(PRODUCT_CLI_ID);

  async function save(): Promise<void> {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const nextModel = normalizeModelId(PRODUCT_CLI_ID, model);
      const response = await fetch('/api/settings/global', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          defaultCli: PRODUCT_CLI_ID,
          cliSettings: { pi: { model: nextModel } },
        }),
      });
      const payload = await response.json().catch(() => null) as { error?: string; message?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.message ?? payload?.error ?? `设置保存失败（HTTP ${response.status}）。`);
      }
      setSettings((current) => ({
        ...current,
        default_cli: PRODUCT_CLI_ID,
        cli_settings: { ...current.cli_settings, pi: { model: nextModel } },
      }));
      await refresh();
      setSaved(true);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="平台设置">
      <button type="button" aria-label="关闭设置" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <section className="relative z-10 w-full max-w-lg rounded-lg border border-border bg-background p-6 shadow-xl">
        <header className="flex items-center justify-between border-b border-border pb-4">
          <div className="flex items-center gap-2">
            <Settings className="h-5 w-5" aria-hidden="true" />
            <h2 className="text-lg font-semibold">平台设置</h2>
          </div>
          <button type="button" className="rounded-md p-2 hover:bg-muted" onClick={onClose} aria-label="关闭设置" title="关闭设置">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>
        <div className="space-y-5 py-5">
          <label className="block space-y-2 text-sm">
            <span className="font-medium">默认模型</span>
            <select value={model} onChange={(event) => setModel(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3">
              {models.map((definition) => <option key={definition.id} value={definition.id}>{definition.name}</option>)}
            </select>
          </label>
          <p className="text-xs text-muted-foreground">CLI：PI Agent。配置保存在当前 Windows 用户的本地数据目录。</p>
          {error && <p className="text-sm text-destructive">读取设置失败：{error.message}</p>}
          {saveError && <p className="text-sm text-destructive">{saveError}</p>}
          {saved && <p className="text-sm text-emerald-600">设置已保存。</p>}
        </div>
        <footer className="flex justify-end gap-2 border-t border-border pt-4">
          <button type="button" className="rounded-md border border-input px-4 py-2 text-sm hover:bg-muted" onClick={onClose}>取消</button>
          <button type="button" className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50" onClick={save} disabled={saving}>
            <Save className="h-4 w-4" aria-hidden="true" />
            {saving ? '保存中...' : '保存'}
          </button>
        </footer>
      </section>
    </div>
  );
}
