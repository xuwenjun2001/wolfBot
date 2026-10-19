const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { reserveEvaluationPhase } = require('./research-evaluation-phase');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-phase-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const campaign = path.join(root, 'data/research-agent-upgrade/evidence/S19/new-campaign');
  return { root, campaign };
}

test('a fresh phase can be claimed only once, including after a failed attempt', t => {
  const { root, campaign } = fixture(t);
  const marker = reserveEvaluationPhase(root, campaign, 'candidate');
  const original = fs.readFileSync(marker, 'utf8');
  assert.throws(() => reserveEvaluationPhase(root, campaign, 'candidate'), /already reserved/);
  assert.equal(fs.readFileSync(marker, 'utf8'), original);
});

test('existing phase output from earlier runners also blocks overwrite', t => {
  const { root, campaign } = fixture(t);
  fs.mkdirSync(path.join(campaign, 'candidate'), { recursive: true });
  fs.writeFileSync(path.join(campaign, 'candidate', 'result.json'), 'retained failure');
  assert.throws(() => reserveEvaluationPhase(root, campaign, 'candidate'), /already started/);
  assert.equal(fs.readFileSync(path.join(campaign, 'candidate', 'result.json'), 'utf8'), 'retained failure');
});

test('baseline protocol and one-time holdout opening are protected', t => {
  const { root, campaign } = fixture(t);
  fs.mkdirSync(campaign, { recursive: true });
  fs.writeFileSync(path.join(campaign, 'protocol.json'), '{}');
  assert.throws(() => reserveEvaluationPhase(root, campaign, 'baseline'), /already started/);
  fs.writeFileSync(path.join(campaign, 'holdout-opened.json'), '{}');
  assert.throws(() => reserveEvaluationPhase(root, campaign, 'holdout'), /already started/);
});

test('invalid phase or campaign fails before creating any experiment files', t => {
  const { root, campaign } = fixture(t);
  assert.throws(() => reserveEvaluationPhase(root, campaign, 'retry'), /Unknown/);
  assert.throws(() => reserveEvaluationPhase(root, '', 'candidate'), /Explicit/);
  assert.throws(() => reserveEvaluationPhase(root, path.join(root, 'outside'), 'candidate'), /S19/);
  assert.equal(fs.existsSync(campaign), false);
});
