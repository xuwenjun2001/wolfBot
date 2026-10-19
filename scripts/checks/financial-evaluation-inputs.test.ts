import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { controlledExternalRoot, normalizeHoldoutTasks } from './financial-evaluation-inputs';

const synthetic = () => ['100001.SH', '100002.SZ'].map((symbol, index) => ({
  id: `synthetic-${index}`, symbol, documentIds: [`synthetic-${index}-2023`, `synthetic-${index}-2024`],
  asOf: '2025-06-30T15:59:59.999Z', questions: ['synthetic income question', 'synthetic cash question', 'synthetic risk question'],
}));
const metadata = () => synthetic().flatMap(task => task.documentIds.map(id => ({ id, symbol: task.symbol, companyName: `synthetic ${task.id}` })));

test('adapts the frozen task shape without changing identity, question text or time', () => {
  const input = synthetic(), result = normalizeHoldoutTasks(input, metadata());
  assert.equal(result.length, 2);
  for (const [index, item] of result.entries()) {
    assert.deepEqual(item.company, { symbol: input[index].symbol, name: `synthetic ${input[index].id}` });
    assert.deepEqual(item.documentIds, input[index].documentIds);
    assert.equal(item.asOf, input[index].asOf);
    assert.deepEqual(item.questions.map(question => question.text), input[index].questions);
    assert.deepEqual(item.questions.map(question => question.id), ['q1', 'q2', 'q3']);
  }
});

test('does not read or forward unreviewed answers and reference fields', () => {
  const input = synthetic();
  for (const task of input) for (const key of ['answers', 'reference']) Object.defineProperty(task, key, { enumerable: true, get() { throw new Error('Unreviewed answer read'); } });
  assert(normalizeHoldoutTasks(input, metadata()).every(task => !('answers' in task) && !('reference' in task)));
});

test('rejects missing questions, missing documents and company mismatches', () => {
  assert.throws(() => normalizeHoldoutTasks([{ ...synthetic()[0], questions: [] }, synthetic()[1]], metadata()));
  assert.throws(() => normalizeHoldoutTasks(synthetic(), metadata().slice(1)), /Two registered/);
  assert.throws(() => normalizeHoldoutTasks(synthetic(), metadata().map((item, index) => index ? item : { ...item, symbol: '999999.SH' })), /mismatch/);
});

test('accepts a sibling with a shared name prefix and rejects repo, children and linked children', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'research-roots-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = path.join(directory, 'repository'), sibling = path.join(directory, 'repository-private'), child = path.join(repository, 'private');
  mkdirSync(repository); mkdirSync(sibling); mkdirSync(child);
  assert.equal(controlledExternalRoot(repository, sibling), sibling);
  assert.throws(() => controlledExternalRoot(repository, repository), /external/);
  assert.throws(() => controlledExternalRoot(repository, child), /external/);
  const alias = path.join(directory, 'external-alias');
  symlinkSync(child, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => controlledExternalRoot(repository, alias), /external/);
});
