const fs = require('node:fs');
const path = require('node:path');

/** Reserve a model phase before creating its disposable database. Never retry in place. */
function reserveEvaluationPhase(root, campaignInput, phase) {
  if (!['baseline', 'candidate', 'holdout'].includes(phase)) throw new Error('Unknown evaluation phase');
  if (!campaignInput) throw new Error('Explicit RESEARCH_EVALUATION_CAMPAIGN required');
  const campaign = path.resolve(campaignInput);
  const parent = path.resolve(root, 'data/research-agent-upgrade/evidence/S19');
  const relative = path.relative(parent, campaign);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Explicit S19 campaign directory required');
  if (fs.existsSync(path.join(campaign, phase))
      || (phase === 'baseline' && fs.existsSync(path.join(campaign, 'protocol.json')))
      || (phase === 'holdout' && fs.existsSync(path.join(campaign, 'holdout-opened.json')))) {
    throw new Error(`Evaluation ${phase} already started; preserve its evidence and register a new experiment`);
  }
  fs.mkdirSync(campaign, { recursive: true });
  const marker = path.join(campaign, `${phase}-attempt.json`);
  try {
    fs.writeFileSync(marker, JSON.stringify({ phase, at: new Date().toISOString(), policy: 'one attempt; keep failures; no in-place replay' }, null, 2) + '\n', { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Evaluation ${phase} already reserved; preserve its evidence and register a new experiment`);
    throw error;
  }
  return marker;
}

module.exports = { reserveEvaluationPhase };
