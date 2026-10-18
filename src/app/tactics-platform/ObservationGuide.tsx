"use client";

import { useState } from "react";
import { BookOpen, ChevronDown, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TacticGuide } from "@/lib/quant/tactics-types";

export default function ObservationGuide({
  guide,
  canEdit,
  onSaved,
}: {
  guide: TacticGuide | null | undefined;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<TacticGuide | null>(null);
  const [saved, setSaved] = useState<TacticGuide | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current =
    saved && (!guide || saved.version > guide.version) ? saved : guide;
  async function save() {
    if (!draft || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/quant/tactics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "guide",
          content: draft.content,
          expected_version: draft.version,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "保存失败，请重试");
      setSaved(result.data);
      setDraft(null);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，请重试");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <Button
        variant="outline"
        aria-expanded={open}
        aria-controls="ma55-observation-guide"
        onClick={() => setOpen(!open)}
      >
        <BookOpen className="mr-2 h-4 w-4" />
        入池后如何观察
        <ChevronDown
          className={`ml-2 h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </Button>
      <div
        id="ma55-observation-guide"
        hidden={!open}
        className="mt-3 rounded-xl border bg-card p-5 md:p-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">55线战法 · 入池后观察指引</h2>
            <p className="mt-1 text-xs leading-6 text-muted-foreground">
              平台共用的观察笔记，可编辑保存；修改文字不会改变筛选规则。
            </p>
          </div>
          {canEdit && current && !draft && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDraft({ ...current });
                setError("");
              }}
            >
              <Pencil className="mr-2 h-3.5 w-3.5" />
              编辑指引
            </Button>
          )}
        </div>
        {draft ? (
          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label htmlFor="ma55-guide-content" className="text-sm">
              观察指引内容
            </label>
            <textarea
              id="ma55-guide-content"
              required
              maxLength={20000}
              rows={20}
              disabled={busy}
              value={draft.content}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
              className="block min-h-72 w-full resize-y rounded-lg border bg-background p-4 text-sm leading-7"
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={busy || !draft.content.trim()}>
                {busy ? "保存中…" : "保存指引"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                  setError("");
                }}
              >
                取消编辑
              </Button>
              <span className="text-xs text-muted-foreground">
                {draft.content.length} / 20000 字符 · 保存后对所有用户生效
              </span>
            </div>
            {error && (
              <p role="alert" className="text-sm text-red-600">
                {error}（草稿已保留）
              </p>
            )}
          </form>
        ) : current ? (
          <>
            <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-7">
              {current.content}
            </p>
            <p className="mt-4 text-xs text-muted-foreground">
              版本 {current.version} · 最近更新{" "}
              {new Date(current.updated_at).toLocaleString("zh-CN", {
                timeZone: "Asia/Shanghai",
              })}
            </p>
          </>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            观察指引暂未加载，请稍后刷新。
          </p>
        )}
      </div>
    </section>
  );
}
