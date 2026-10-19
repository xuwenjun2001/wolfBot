/** Map a whitespace/NFKC-insensitive match back to retained UTF-16 source offsets. */
export function citationTextRange(text: string, quote: string): { start: number; end: number } | null {
  const needle = quote.normalize('NFKC').replace(/\s+/gu, '');
  if (!needle) return null;
  const exact = text.indexOf(quote);
  if (exact >= 0) return { start: exact, end: exact + quote.length };
  const parts: string[] = [], starts: number[] = [], ends: number[] = [];
  // Graphemes preserve combining sequences and compatibility characters that expand under NFKC.
  for (const { segment, index } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    const normalized = segment.normalize('NFKC').replace(/\s+/gu, '');
    parts.push(normalized);
    for (let i = 0; i < normalized.length; i++) { starts.push(index); ends.push(index + segment.length); }
  }
  const at = parts.join('').indexOf(needle);
  return at < 0 ? null : { start: starts[at], end: ends[at + needle.length - 1] };
}
