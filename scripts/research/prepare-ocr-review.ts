import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parsedDocumentV2Schema } from '../../src/lib/company-research/parsed-document';
import { artifactDigest } from '../../src/lib/company-research/artifact-store';

async function main() {
  const evidence = path.resolve('data/research-agent-upgrade/evidence/S08');
  const service = process.argv[2];
  if (!service) throw new Error('Pass the service evidence directory containing synthetic.json');
  const root = path.join(evidence, 'human-review-01'); await mkdir(root, { recursive: true });
  const samples = [
    ...['scan-maotai-p5', 'native-maotai-p5', 'native-midea-p9'].map(name => ({ name, receipt: path.join(evidence, 'probe-01', name + '.json'), images: [path.join(evidence, 'probe-01', name + '.png')] })),
    { name: 'synthetic-two-page-table', receipt: path.resolve(service, 'synthetic.json'), images: [1, 2].map(n => path.join(evidence, 'synthetic-01', `synthetic-table-p${n}.png`)) },
  ];
  const rows: string[] = [], manifest = [];
  for (const sample of samples) {
    const bytes = await readFile(sample.receipt), r = parsedDocumentV2Schema.parse(JSON.parse(bytes.toString()));
    const hashes = [];
    rows.push(`## ${sample.name}`, '', `原件 SHA-256：${r.originalSha256}；解析器：${r.parser.version}。`, '');
    for (const img of sample.images) {
      const relative = path.relative(root, img).replaceAll('\\', '/');
      rows.push(`![原图 ${path.basename(img)}](${relative})`, '');
      hashes.push({ path: path.relative(evidence, img).replaceAll('\\', '/'), sha256: artifactDigest(await readFile(img)) });
    }
    for (const p of r.pages) for (const b of p.blocks.filter(b => b.table)) {
      rows.push(`文件页 ${p.filePage} / ${b.table!.id} / ${b.quality}；请按原图核对单位、年份、金额符号与列归属。`, '', '| 行 | 列 | 行跨度 | 列跨度 | 识别文本 |', '| --- | --- | --- | --- | --- |');
      rows.push(...b.table!.cells.map(c => `| ${c.row} | ${c.column} | ${c.rowSpan} | ${c.columnSpan} | ${c.text.replace(/\|/g, '\\|').replace(/\n/g, '<br>')} |`), '');
    }
    manifest.push({ sample: sample.name, receipt: path.relative(evidence, sample.receipt).replaceAll('\\', '/'), receiptSha256: artifactDigest(bytes), originalSha256: r.originalSha256, images: hashes });
  }
  await writeFile(path.join(root, 'review.md'), ['# S08 OCR 人工抽查材料', '',
    '本文件由程序生成，只是原图与提取表格的对照材料。人工状态：pending；AI 看图与机器匹配不算真人确认。真实财报与合成压力样本分别标注；扫描茅台样本是原年报文件页 5 的派生单页，派生文件的 filePage 为 1。', '',
    '抽查重点：茅台的元、美的的千元；2024/2023 年列；括号负数 (1,234.50)/(12.34)、负号 -56.78、小数点、0.00；合并表头跨三列；跨页保留两个独立表格。请记录发现的错误，不能只核对金额是否在整页某处出现。', '',
    ...rows, '## 真人记录（留待填写）', '', '- 核对人：', '- 日期：', '- 核对范围与发现：', '- 结论：pending', '',
    '这是解析器样本抽查，不是所有财报的准确率证明，也不会自动解除业务资料的 needs_review。', ''].join('\n'));
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, humanReview: 'pending', samples: manifest }, null, 2));
  console.log(path.join(root, 'review.md'));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
