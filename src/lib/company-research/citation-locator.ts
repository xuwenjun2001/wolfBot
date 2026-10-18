import type { VersionedCitation } from './document-contracts';
import type { ParsedDocument } from './parsed-document';
import { canonicalResearchJson } from './task-contracts';

export function locatedCitationText(receipt: ParsedDocument, citation: VersionedCitation): string | undefined {
  const loc = citation.locator;
  if (loc.kind === 'page') return receipt.failedPages.includes(loc.filePage) ? undefined : receipt.pages.find(p => p.filePage === loc.filePage)?.text;
  const blocks = receipt.pages.filter(p => !receipt.failedPages.includes(p.filePage)).flatMap(p => p.blocks);
  if (loc.kind === 'block' || loc.kind === 'html') {
    const block = blocks.find(b => b.id === loc.blockId);
    return block && canonicalResearchJson(block.locator) === canonicalResearchJson(loc) && block.quality !== 'unreadable' ? block.text : undefined;
  }
  const block = blocks.find(b => b.table?.id === loc.tableId && b.locator.kind !== 'html' && b.locator.filePage === loc.filePage);
  const cell = block?.table?.cells.find(c => c.row === loc.row && c.column === loc.column);
  if (!cell || block?.quality === 'unreadable') return;
  if (loc.box && canonicalResearchJson(loc.box) !== canonicalResearchJson(cell.box)) return;
  return cell.text;
}
