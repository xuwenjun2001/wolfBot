import type { Metadata } from 'next';
import FinancialWorkbench from './financial/FinancialWorkbench';
import { redirect } from 'next/navigation';
export const metadata: Metadata = { title: '财报变化研究 · wolfbot', description: '比较双期财报、核查结论并定位原文。' };
export default async function CompanyResearchPage({ searchParams }: {searchParams: Promise<{run?: string}>}) {
  const { run } = await searchParams;
  if (run) redirect(`/company-research/legacy?run=${encodeURIComponent(run)}`);
  return <FinancialWorkbench />;
}
