export const SEMANTIC_EDIT_CSS_APPEND_LIMITS = Object.freeze({
  maxChars: 16_000,
  maxLines: 160,
  maxNodes: 320,
});

export const SEMANTIC_EDIT_CSS_APPEND_LIMIT_TEXT =
  `${SEMANTIC_EDIT_CSS_APPEND_LIMITS.maxChars.toLocaleString('en-US')} characters and ` +
  `${SEMANTIC_EDIT_CSS_APPEND_LIMITS.maxLines} normalized lines, with at most ` +
  `${SEMANTIC_EDIT_CSS_APPEND_LIMITS.maxNodes} CSS AST nodes`;

export const PREPARED_CUSTOM_SEMANTIC_EDIT_SUBMIT_HINT =
  'After a successful semantic_edit on this prepared custom surface, call submit_result ' +
  'on the next turn without rereading or making another edit; retry only when semantic_edit ' +
  'returns an error.';
