import { sourceSelectionSchema } from './reader-contracts';
import { getResearchTask, getResearchReportRevision } from './version-store';
import { getResearchDocument, readResearchDocumentArtifact } from './document-store';
import { parsedReceiptSchema } from './parsed-document';
import { locatedCitationText } from './citation-locator';
import { normalEvidence, claimReviewHash } from './claim-verification';
import { citationTextRange } from './evidence-text';
import { defaultResearchContext, ResearchPersistenceError } from './repository-core';

export async function readResearchSource(actor: string, taskId: string, input: unknown, ctx = defaultResearchContext) {
  const selection = sourceSelectionSchema.parse(input), task = await getResearchTask(actor, taskId, ctx);
  if (!task) throw new ResearchPersistenceError('NOT_FOUND');
  const report = selection.reportRevision ? await getResearchReportRevision(actor, taskId, selection.reportRevision, ctx) : null;
  if (selection.reportRevision && !report) throw new ResearchPersistenceError('NOT_FOUND');
  const state = report || task.checkpoint;
  const item = selection.claimId ? state?.claims.find(c => c.id === selection.claimId) : state?.facts.find(f => f.id === selection.factId);
  const citation = item?.citations[selection.citationIndex]; if (!citation) throw new ResearchPersistenceError('NOT_FOUND');
  // Explicit historical version: never switch to latest document or latest index.
  const document = await getResearchDocument(actor, taskId, citation.documentId, citation.documentVersion, ctx);
  if (!document || document.bytesSha256 !== citation.bytesSha256) throw new ResearchPersistenceError('NOT_FOUND');
  const { bytes } = await readResearchDocumentArtifact(actor, taskId, document.id, document.version, 'parsed', ctx);
  const receipt = parsedReceiptSchema.parse(JSON.parse(bytes.toString())), loc = citation.locator;
  const page = receipt.pages.find(p => loc.kind !== 'html' && p.filePage === loc.filePage);
  const located = receipt.schemaVersion === 2 ? locatedCitationText(receipt, citation) : loc.kind === 'page' ? page?.text : undefined;
  if (!located || !normalEvidence(located).includes(normalEvidence(citation.quote))) throw new ResearchPersistenceError('INVALID_RESEARCH', '引用与保留原文不一致');
  const blocks = receipt.schemaVersion === 2 ? receipt.pages.flatMap(p => p.blocks) : [];
  const block = blocks.find(b => loc.kind === 'block' || loc.kind === 'html' ? b.id === loc.blockId : loc.kind === 'table' ? b.table?.id === loc.tableId && b.locator.kind !== 'html' && b.locator.filePage === loc.filePage : false);
  const grid = block?.table;
  const cell = loc.kind === 'table' ? grid?.cells.find(c => c.row === loc.row && c.column === loc.column) : undefined;
  const text = loc.kind === 'page' ? page?.text || located : block?.text || located;
  const range = citationTextRange(text, citation.quote);
  if (!range) throw new ResearchPersistenceError('INVALID_RESEARCH', '引用无法定位到原文范围');
  const start = Math.max(0, range.start - 1200), excerpt = text.slice(start, start + 9000);
  const exact = excerpt.indexOf(citation.quote);
  const claim = selection.claimId ? state?.claims.find(c => c.id === selection.claimId) : undefined;
  const review = claim && report ? task.reviews.find(r => r.claimHash === claimReviewHash(report, claim)) : null;
  return { selection, citation, document: { id: document.id, version: document.version, title: document.title, url: document.url, mediaType: document.mediaType, bytesSha256: document.bytesSha256, disclosure: document.disclosure, state: document.state },
    text: excerpt, textOffset: start, truncated: start > 0 || start + excerpt.length < text.length,
    highlight: exact >= 0 ? { start: exact, end: exact + citation.quote.length, mode: 'exact_text' as const } : null,
    coordinate: cell?.box || block?.locator.kind === 'block' && block.locator.box || null,
    quality: block?.quality || (blocks.filter(b => loc.kind !== 'html' && b.locator.kind !== 'html' && b.locator.filePage === loc.filePage).some(b => b.quality !== 'native') ? 'needs_review' : 'native'),
    table: grid && grid.cells.length <= 500 ? grid : null, selectedCell: cell ? { row: cell.row, column: cell.column } : null,
    verification: { originalQuote: true, semantic: review?.verdict || 'pending', method: review?.method || null, independence: review?.independence || null, reason: review?.reason || '原文定位已核对，语义支持需单独审查' } };
}
