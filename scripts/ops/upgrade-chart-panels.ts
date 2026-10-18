import fs from 'fs/promises';
import path from 'path';
import { upgradeChartProject, rollbackChartProject } from '../../src/lib/utils/chart-panel-upgrade';

async function main() {
const root = path.resolve('data/projects');
const args = process.argv.slice(2);
const specified = args.find(a => a.startsWith('--project='))?.slice('--project='.length);
const names = specified ? [specified] : (await fs.readdir(root, { withFileTypes: true })).filter(e => e.isDirectory() && !e.isSymbolicLink()).map(e => e.name);
for (const name of names) {
  const target = path.resolve(root, name);
  if (path.dirname(target) !== root) throw new Error('Project must be a direct child of data/projects');
  try {
    console.log(JSON.stringify(args.includes('--rollback') ? await rollbackChartProject(target) : await upgradeChartProject(target, args.includes('--apply'), args.includes('--enrich'))));
  } catch (error) { console.error(JSON.stringify({ project: name, error: String(error) })); process.exitCode = 1; }
}
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
