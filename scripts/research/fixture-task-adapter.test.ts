import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createFixtureTaskInput, loadFixtureTaskDocuments, type FixtureTaskInput } from './fixture-task-adapter';

const dataset = () => readFile('fixtures/company-research/development-v2.json', 'utf8').then(JSON.parse);
test('all 14 task inputs preserve actual years and all 30 documents without evaluation answers', async () => {
  const data = await dataset();
  const inputs: FixtureTaskInput[] = data.cases.map((sample: unknown) => createFixtureTaskInput(sample, data.documents));
  assert.equal(inputs.length, 14);
  assert.equal(inputs.reduce((sum, input) => sum + input.documents.length, 0), 30);
  for (const [index, input] of inputs.entries()) {
    assert.deepEqual(input.documentScope.taskDocumentIds, data.cases[index].documentIds);
    assert.deepEqual(input.documentScope.primaryDocumentIds, data.cases[index].primaryDocumentIds);
    assert.deepEqual(input.documentScope.supportingDocumentIds, data.cases[index].supportingDocumentIds);
    assert.deepEqual(input.spec.periods.map(period => period.end), data.cases[index].periods.map((period: { end: string }) => period.end));
    assert.deepEqual(input.spec.questions.map(question => question.id), ['income_profit', 'cash_flow', 'risks']);
    assert.deepEqual(input.spec.questions.map(question => question.text), data.cases[index].questions.map((question: { text: string }) => question.text));
    const serialized = JSON.stringify(input);
    for (const forbidden of ['acceptedReference', 'answerability', 'reference', 'normalizedYuan', 'rawValue', 'percentage', 'comparisonFacts', 'executionReadiness']) assert.equal(serialized.includes(`"${forbidden}"`), false, `${input.caseId}: ${forbidden}`);
  }
  for (const id of ['dev-601318', 'dev-601601']) assert.deepEqual(inputs.find(input => input.caseId === id)!.spec.periods.map(period => period.id), ['FY2022', 'FY2023']);
  for (const id of ['dev-002304', 'dev-600426']) assert.equal(inputs.find(input => input.caseId === id)!.documents.length, 3);
});

test('actual fixed bytes load all 14 tasks with scan and insurance partial quality preserved', async () => {
  const data = await dataset();
  let documents = 0;
  for (const sample of data.cases) {
    const input = createFixtureTaskInput(sample, data.documents);
    const loaded = await loadFixtureTaskDocuments(input, '11111111-1111-4111-8111-111111111111');
    documents += loaded.length;
    assert.deepEqual(loaded.map(item => item.document.id), sample.documentIds);
    for (const item of loaded) {
      const meta = data.documents.find((document: { id: string }) => document.id === item.document.id);
      assert.equal(item.document.state, meta.parserReceipt.status);
      assert.equal(item.document.period.end, meta.period.end);
      assert.equal(item.document.disclosure.status, 'verified');
      assert.equal(item.original.length, meta.byteLength);
    }
    if (input.documentScope.supportingDocumentIds.length) {
      const scan = loaded.find(item => input.documentScope.supportingDocumentIds.includes(item.document.id))!;
      assert.equal(scan.document.state, 'partial');
      assert.ok(scan.document.parser!.failedPages.length > 3);
      assert.ok(JSON.parse(scan.parsed.toString()).pages.flatMap((page: { blocks: { quality: string }[] }) => page.blocks).some((block: { quality: string }) => block.quality === 'needs_review'));
    }
  }
  assert.equal(documents, 30);
});

test('scope, questions and changed original or receipt hashes fail closed', async () => {
  const data = await dataset(), scan = structuredClone(data.cases.find((sample: { id: string }) => sample.id === 'dev-002304'));
  scan.supportingDocumentIds = [];
  assert.throws(() => createFixtureTaskInput(scan, data.documents), /SCOPE_BINDING/);
  const sample = structuredClone(data.cases[0]);
  sample.questions[1].id = 'income_profit';
  assert.throws(() => createFixtureTaskInput(sample, data.documents), /three research questions/);
  const input = createFixtureTaskInput(data.cases[0], data.documents);
  const changedOriginal = structuredClone(input); changedOriginal.documents[0].bytesSha256 = '0'.repeat(64);
  await assert.rejects(loadFixtureTaskDocuments(changedOriginal, '11111111-1111-4111-8111-111111111111'), /ORIGINAL_HASH/);
  const changedReceipt = structuredClone(input); changedReceipt.documents[0].parserReceipt!.sha256 = '0'.repeat(64);
  await assert.rejects(loadFixtureTaskDocuments(changedReceipt, '11111111-1111-4111-8111-111111111111'), /PARSER_HASH/);
});
