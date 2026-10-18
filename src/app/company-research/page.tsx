import type { Metadata } from 'next';
import CompanyResearchClient from './CompanyResearchClient';
export const metadata: Metadata = { title: '公司研究 · wolfbot', description: '自主研究主营业务、上下游和近期财报，实时查看调查步骤与证据。' };
export default function CompanyResearchPage() { return <CompanyResearchClient />; }
