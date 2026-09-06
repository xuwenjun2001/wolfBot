import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="shell-main">
      <section className="status-panel">
        <span className="status-label">404</span>
        <h1>页面不存在</h1>
        <p>
          <Link href="/">返回研究工作台</Link>
        </p>
      </section>
    </main>
  );
}
