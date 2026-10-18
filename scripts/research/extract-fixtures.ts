/** Evaluation preparation, not the production parser planned for S07/S08. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PDFParse } from 'pdf-parse';

async function main() {
const file = process.argv[2];
if (!file) throw new Error('Pass the local development or controlled holdout manifest path');
const manifest = JSON.parse(await readFile(file, 'utf8'));
for (const document of manifest.documents) {
  const bytes = await readFile(document.path);
  if (createHash('sha256').update(bytes).digest('hex') !== document.bytesSha256) throw new Error('PDF hash mismatch');
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    const result = await parser.getText();
    const text = result.pages.map(page => `[第 ${page.num} 页]\n${page.text}`).join('\n');
    const pagesPath = document.path.replace(/\.pdf$/i, '.pages.json');
    await writeFile(pagesPath, JSON.stringify(result.pages.map(page => ({ page: page.num, text: page.text })), null, 2) + '\n');
    await writeFile(document.path.replace(/\.pdf$/i, '.txt'), text);
    document.pageCount = result.total;
    document.preparationParser = 'pdf-parse@2.4.5; full document; evaluation preparation only';
    document.pagesPath = pagesPath;
    document.textSha256 = createHash('sha256').update(text).digest('hex');
    console.log(document.id, result.total, 'pages');
  } finally { await parser.destroy(); }
}
await writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
