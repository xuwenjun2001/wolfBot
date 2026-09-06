'use client';

import { useEffect, useState } from 'react';
import { Save, Settings, X } from 'lucide-react';

interface ProjectSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  projectName: string;
  projectDescription?: string | null;
  initialTab?: 'general' | 'ai-assistant' | 'environment' | 'services';
  onProjectUpdated?: (update: { name: string; description?: string | null }) => void;
}

export function ProjectSettings({
  isOpen,
  onClose,
  projectId,
  projectName,
  projectDescription = '',
  onProjectUpdated,
}: ProjectSettingsProps) {
  const [name, setName] = useState(projectName);
  const [description, setDescription] = useState(projectDescription ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setName(projectName);
      setDescription(projectDescription ?? '');
      setError(null);
    }
  }, [isOpen, projectName, projectDescription]);

  if (!isOpen) return null;

  async function save(): Promise<void> {
    const nextName = name.trim();
    if (!nextName) {
      setError('项目名称不能为空。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nextName, description: description.trim() || null }),
      });
      const payload = await response.json().catch(() => null) as { error?: string; message?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.message ?? payload?.error ?? `项目更新失败（HTTP ${response.status}）。`);
      }
      onProjectUpdated?.({ name: nextName, description: description.trim() || null });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="项目设置">
      <button type="button" aria-label="关闭项目设置" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <section className="relative z-10 w-full max-w-lg rounded-lg border border-border bg-background p-6 shadow-xl">
        <header className="flex items-center justify-between border-b border-border pb-4">
          <div className="flex items-center gap-2">
            <Settings className="h-5 w-5" aria-hidden="true" />
            <h2 className="text-lg font-semibold">项目设置</h2>
          </div>
          <button type="button" className="rounded-md p-2 hover:bg-muted" onClick={onClose} aria-label="关闭项目设置" title="关闭项目设置">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>
        <div className="space-y-4 py-5">
          <label className="block space-y-2 text-sm">
            <span className="font-medium">项目名称</span>
            <input className="h-10 w-full rounded-md border border-input bg-background px-3" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
          </label>
          <label className="block space-y-2 text-sm">
            <span className="font-medium">项目描述</span>
            <textarea className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={20_000} />
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
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

export default ProjectSettings;
