import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cninfoDisclosure, discoverResearchFilings } from '../../src/lib/company-research/filing-acquisition';
import { downloadResearchOriginal } from '../../src/lib/company-research/network';
import { artifactDigest } from '../../src/lib/company-research/artifact-store';
import { specFixture } from '../../src/lib/company-research/version-test-fixtures';

async function main() {
const root = path.resolve('data/research-agent-upgrade/evidence/S06', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(root, { recursive: true });
const manifest = JSON.parse(await readFile('data/research-agent-upgrade/dataset-v1/development/manifest.json', 'utf8'));
const dates = [];
for (const doc of manifest.documents) {
  const item = JSON.parse(await readFile(doc.path.replace(/\.pdf$/, '.announcement.json'), 'utf8'));
  const raw = Buffer.from(JSON.stringify(item)), result = cninfoDisclosure(item, raw, 'https://www.cninfo.com.cn/new/hisAnnouncement/query');
  assert(result.disclosure.status === 'verified' && result.disclosure.precision === 'date');
  dates.push({ id: doc.id, frozenOn: doc.disclosedOn, shanghaiOn: result.disclosure.on, timestamp: item.announcementTime, evidenceSha256: artifactDigest(raw) });
}
const discovery = await discoverResearchFilings(specFixture(), AbortSignal.timeout(60000));
await writeFile(path.join(root, 'discovery.json'), JSON.stringify(discovery, (_k, v) => v?.type === 'Buffer' ? { sha256: artifactDigest(Buffer.from(v.data)) } : v, 2));
const first = manifest.documents[0], downloaded = await downloadResearchOriginal(first.url, AbortSignal.timeout(60000), 50_000_000);
assert.equal(artifactDigest(downloaded.bytes), first.bytesSha256);
await writeFile(path.join(root, 'report.json'), JSON.stringify({ dates, originalDownload: { url: downloaded.url, bytesSha256: artifactDigest(downloaded.bytes), byteLength: downloaded.bytes.length }, candidateCount: discovery.candidates.length, providers: [...new Set(discovery.candidates.map(c => c.provider))], failures: discovery.failures, frozenInputsModified: false }, null, 2));
console.log(JSON.stringify({ evidence: root, dates: dates.length, downloadedHashMatches: true, candidates: discovery.candidates.length, failures: discovery.failures }));
assert(discovery.candidates.length > 0, 'No public discovery candidate; inspect evidence');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
