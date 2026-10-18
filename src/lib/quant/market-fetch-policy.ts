import ts from 'typescript';

// Only accept URL expressions whose destination can be established statically.
// An encoded dynamic segment cannot introduce separators; use '..' when checking
// it so even its worst-case URL dot-segment normalization stays inside the proxy.
function urlShape(node: ts.Expression): string | null {
  if (ts.isParenthesizedExpression(node)) return urlShape(node.expression);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = urlShape(node.left);
    const right = urlShape(node.right);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    && node.expression.text === 'encodeURIComponent' && node.arguments.length === 1
    && !ts.isSpreadElement(node.arguments[0])) return '..';
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const part = urlShape(span.expression);
      if (part === null) return null;
      value += part + span.literal.text;
    }
    return value;
  }
  return null;
}

function isMarketUrl(node: ts.Expression | undefined): boolean {
  if (!node) return false;
  const value = urlShape(node);
  if (value === null || !value.startsWith('/api/market/') || /[\\\r\n\t]/.test(value)) return false;
  const url = new URL(value, 'https://quantpilot.invalid');
  return url.origin === 'https://quantpilot.invalid' && url.pathname.startsWith('/api/market/');
}

/** Inspect actual calls, ignoring comments and strings that merely mention fetch. */
export function hasDisallowedMarketFetch(content: string, fileName = 'component.tsx'): boolean {
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let disallowed = false;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const target = node.expression;
      const isFetch = (ts.isIdentifier(target) && target.text === 'fetch')
        || (ts.isPropertyAccessExpression(target) && target.name.text === 'fetch')
        || (ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression)
          && target.argumentExpression.text === 'fetch');
      if (isFetch && !isMarketUrl(node.arguments[0])) disallowed = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return disallowed;
}
