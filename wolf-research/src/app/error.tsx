'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="shell-main">
      <section className="status-panel">
        <span className="status-label">Application error</span>
        <h1>页面加载失败</h1>
        <p>{error.message || '发生了未分类错误。'}</p>
        <button type="button" onClick={reset}>
          重试
        </button>
      </section>
    </main>
  );
}
