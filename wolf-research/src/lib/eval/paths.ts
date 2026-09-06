import path from 'path';

export const ROOT = process.cwd();
export const CASES_PATH = path.join(ROOT, 'benchmarks', 'quantpilot', 'cases.json');
export const EVAL_SETS_PATH = path.join(ROOT, 'benchmarks', 'quantpilot', 'eval-sets.json');

function configuredPath(value: string | undefined, fallback: string): string {
  const candidate = value?.trim() || fallback;
  return path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(ROOT, candidate);
}

const EVAL_RUNTIME_DIR = configuredPath(process.env.WOLF_RESEARCH_EVAL_RUNTIME_DIR, './tmp/eval');
export const REPORTS_DIR = configuredPath(process.env.WOLF_RESEARCH_REPORTS_DIR, './data/eval-reports');
export const LOG_DIR = configuredPath(
  process.env.WOLF_RESEARCH_EVAL_LOGS_DIR,
  path.join(EVAL_RUNTIME_DIR, 'logs'),
);
