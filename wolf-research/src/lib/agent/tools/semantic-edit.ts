import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

import postcss from 'postcss';
import ts from 'typescript';

import type { PiAgentTool } from '@/lib/agent/types';

import { PiAgentToolError, throwIfAborted } from './errors';
import type { PiAgentFileToolOptions } from './filesystem';
import { writePiAgentWorkspaceBatch } from './filesystem';
import { inputRecord, optionalInteger, requiredString } from './input';
import { PiAgentWorkspacePolicy } from './path-policy';
import { DEFAULT_TOOL_TIMEOUT_MS, executePiAgentTool } from './runtime';
import {
  PREPARED_CUSTOM_SEMANTIC_EDIT_SUBMIT_HINT,
  SEMANTIC_EDIT_CSS_APPEND_LIMITS,
  SEMANTIC_EDIT_CSS_APPEND_LIMIT_TEXT,
} from './semantic-edit-contract';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_SEMANTIC_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_REPLACEMENT_CHARS = 200_000;
const DEFAULT_MAX_LINE_RANGE_LINES = 80;
const DEFAULT_MAX_LINE_RANGE_FRACTION = 0.35;
const SEMANTIC_SOURCE_PATTERN = /\.(?:ts|tsx|css)$/i;

export type SemanticEditKind =
  | 'typescript_symbol'
  | 'css_rule'
  | 'css_append'
  | 'line_range';

const ALL_SEMANTIC_EDIT_KINDS: readonly SemanticEditKind[] = [
  'typescript_symbol',
  'css_rule',
  'css_append',
  'line_range',
];

type SemanticEditInput =
  | {
      path: string;
      kind: 'typescript_symbol';
      beforeSha256: string;
      symbol: string;
      replacement: string;
    }
  | {
      path: string;
      kind: 'css_rule';
      beforeSha256: string;
      selector: string;
      replacement: string;
    }
  | {
      path: string;
      kind: 'css_append';
      beforeSha256: string;
      replacement: string;
    }
  | {
      path: string;
      kind: 'line_range';
      beforeSha256: string;
      startLine: number;
      endLine: number;
      replacement: string;
    };

export interface SemanticEditOutput {
  path: string;
  kind: SemanticEditInput['kind'];
  target: string;
  startLine: number;
  endLine: number;
  beforeSha256: string;
  afterSha256: string;
  bytes: number;
}

export interface PiAgentSemanticEditToolOptions extends Pick<
  PiAgentFileToolOptions,
  | 'workspaceRoot'
  | 'allowedWriteGlobs'
  | 'includeDefaultWriteGlobs'
  | 'timeoutMs'
  | 'maxFileBytes'
  | 'maxWriteBytes'
  | 'resourceLockWaitTimeoutMs'
> {
  maxReplacementChars?: number;
  requireTerminalSubmissionAfterSuccess?: boolean;
  /** Restrict the edit grammar for a prepared delivery surface. */
  allowedKinds?: readonly SemanticEditKind[];
}

function validateSha256(value: string): string {
  const normalized = value.toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new PiAgentToolError(
      'INVALID_TOOL_INPUT',
      'beforeSha256 must be a lowercase or uppercase 64-character SHA-256 digest.',
    );
  }
  return normalized;
}

function parseInput(
  value: unknown,
  maxReplacementChars: number,
  allowedKinds: readonly SemanticEditKind[] = ALL_SEMANTIC_EDIT_KINDS,
): SemanticEditInput {
  const record = inputRecord(value);
  const path = requiredString(record, 'path', { maxLength: 1_024 });
  const kind = requiredString(record, 'kind', { maxLength: 64 });
  if (!allowedKinds.includes(kind as SemanticEditKind)) {
    throw new PiAgentToolError(
      'INVALID_TOOL_INPUT',
      `kind must be one of: ${allowedKinds.join(', ')}.`,
    );
  }
  const beforeSha256 = validateSha256(requiredString(record, 'beforeSha256', { maxLength: 64 }));
  const replacement = requiredString(record, 'replacement', {
    allowEmpty: true,
    maxLength: maxReplacementChars,
  });
  if (kind === 'typescript_symbol') {
    return {
      path,
      kind,
      beforeSha256,
      symbol: requiredString(record, 'symbol', { maxLength: 256 }),
      replacement,
    };
  }
  if (kind === 'css_rule') {
    return {
      path,
      kind,
      beforeSha256,
      selector: requiredString(record, 'selector', { maxLength: 1_024 }),
      replacement,
    };
  }
  if (kind === 'css_append') {
    return { path, kind, beforeSha256, replacement };
  }
  if (kind === 'line_range') {
    if (record.startLine === undefined || record.endLine === undefined) {
      throw new PiAgentToolError(
        'INVALID_TOOL_INPUT',
        'startLine and endLine are required for line_range edits.',
      );
    }
    const startLine = optionalInteger(record, 'startLine', 1, { min: 1, max: 1_000_000 });
    const endLine = optionalInteger(record, 'endLine', 1, { min: 1, max: 1_000_000 });
    if (endLine < startLine) {
      throw new PiAgentToolError('INVALID_TOOL_INPUT', 'endLine must be greater than or equal to startLine.');
    }
    return { path, kind, beforeSha256, startLine, endLine, replacement };
  }
  throw new PiAgentToolError(
    'INVALID_TOOL_INPUT',
    'kind must be typescript_symbol, css_rule, css_append, or line_range.',
  );
}

function scriptKind(filePath: string): ts.ScriptKind {
  if (/\.tsx$/i.test(filePath)) return ts.ScriptKind.TSX;
  if (/\.ts$/i.test(filePath)) return ts.ScriptKind.TS;
  throw new PiAgentToolError(
    'SEMANTIC_EDIT_FILE_TYPE_MISMATCH',
    'typescript_symbol edits require a .ts or .tsx file.',
  );
}

function assertSemanticSourceFile(filePath: string): void {
  if (!SEMANTIC_SOURCE_PATTERN.test(filePath)) {
    throw new PiAgentToolError(
      'SEMANTIC_EDIT_FILE_TYPE_MISMATCH',
      'semantic_edit only supports existing .ts, .tsx, and .css source files.',
    );
  }
}

function declarationNames(statement: ts.Statement): string[] {
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    return statement.name ? [statement.name.text] : [];
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : []);
  }
  return [];
}

type TypeScriptDeclarationKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type_alias'
  | 'enum'
  | 'variable';

type VariableDeclarationKind = 'var' | 'let' | 'const' | 'using' | 'await_using';

interface TypeScriptDeclarationIdentity {
  declarationKind: TypeScriptDeclarationKind;
  modifierKinds: number[];
  functionAsync: boolean | null;
  functionGenerator: boolean | null;
  variableKind: VariableDeclarationKind | null;
}

function typeScriptDeclarationKind(statement: ts.Statement): TypeScriptDeclarationKind {
  if (ts.isFunctionDeclaration(statement)) return 'function';
  if (ts.isClassDeclaration(statement)) return 'class';
  if (ts.isInterfaceDeclaration(statement)) return 'interface';
  if (ts.isTypeAliasDeclaration(statement)) return 'type_alias';
  if (ts.isEnumDeclaration(statement)) return 'enum';
  if (ts.isVariableStatement(statement)) return 'variable';
  throw new PiAgentToolError(
    'SEMANTIC_TARGET_UNSAFE',
    'Only named top-level functions, classes, interfaces, type aliases, enums, and variables can be replaced.',
  );
}

function variableDeclarationKind(statement: ts.VariableStatement): VariableDeclarationKind {
  const flags = statement.declarationList.flags;
  if ((flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing) return 'await_using';
  if ((flags & ts.NodeFlags.Using) === ts.NodeFlags.Using) return 'using';
  if ((flags & ts.NodeFlags.Const) === ts.NodeFlags.Const) return 'const';
  if ((flags & ts.NodeFlags.Let) === ts.NodeFlags.Let) return 'let';
  return 'var';
}

function declarationIdentity(statement: ts.Statement): TypeScriptDeclarationIdentity {
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
  const modifierKinds = (modifiers ?? [])
    .map((modifier) => modifier.kind)
    .sort((left, right) => left - right);
  return {
    declarationKind: typeScriptDeclarationKind(statement),
    modifierKinds,
    functionAsync: ts.isFunctionDeclaration(statement)
      ? modifierKinds.includes(ts.SyntaxKind.AsyncKeyword)
      : null,
    functionGenerator: ts.isFunctionDeclaration(statement) ? statement.asteriskToken !== undefined : null,
    variableKind: ts.isVariableStatement(statement) ? variableDeclarationKind(statement) : null,
  };
}

function sameDeclarationIdentity(
  expected: TypeScriptDeclarationIdentity,
  received: TypeScriptDeclarationIdentity,
): boolean {
  return (
    expected.declarationKind === received.declarationKind &&
    expected.functionAsync === received.functionAsync &&
    expected.functionGenerator === received.functionGenerator &&
    expected.variableKind === received.variableKind &&
    expected.modifierKinds.length === received.modifierKinds.length &&
    expected.modifierKinds.every((kind, index) => kind === received.modifierKinds[index])
  );
}

function lineNumberAt(sourceFile: ts.SourceFile, offset: number): number {
  return sourceFile.getLineAndCharacterOfPosition(offset).line + 1;
}

function sourceParseDiagnostics(sourceFile: ts.SourceFile): readonly ts.Diagnostic[] {
  return (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics ?? [];
}

function replaceTypeScriptSymbol(
  filePath: string,
  content: string,
  symbol: string,
  replacement: string,
): { content: string; startLine: number; endLine: number } {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filePath),
  );
  if (sourceParseDiagnostics(sourceFile).length > 0) {
    throw new PiAgentToolError(
      'SEMANTIC_SOURCE_PARSE_FAILED',
      `Cannot safely edit ${filePath} because its TypeScript syntax is invalid.`,
    );
  }
  const matches = sourceFile.statements.filter((statement) =>
    declarationNames(statement).includes(symbol));
  if (matches.length === 0) {
    throw new PiAgentToolError(
      'SEMANTIC_TARGET_NOT_FOUND',
      `No top-level TypeScript declaration named ${symbol} exists in ${filePath}.`,
    );
  }
  if (matches.length > 1) {
    throw new PiAgentToolError(
      'SEMANTIC_TARGET_AMBIGUOUS',
      `More than one top-level TypeScript declaration is named ${symbol} in ${filePath}. Do not retry this semantic target or reread the unchanged file; reuse beforeSha256 and the last query_text_file line numbers with kind=line_range.`,
    );
  }
  const statement = matches[0];
  if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length !== 1) {
    throw new PiAgentToolError(
      'SEMANTIC_TARGET_UNSAFE',
      `Declaration ${symbol} shares a variable statement with other symbols and cannot be replaced safely.`,
    );
  }
  if (!replacement.trim()) {
    throw new PiAgentToolError(
      'SEMANTIC_REPLACEMENT_INVALID',
      'typescript_symbol replacement cannot be empty; use an explicit line_range edit to remove code.',
    );
  }
  const replacementFile = ts.createSourceFile(
    `replacement-${filePath}`,
    replacement,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filePath),
  );
  if (sourceParseDiagnostics(replacementFile).length > 0 || replacementFile.statements.length !== 1) {
    throw new PiAgentToolError(
      'SEMANTIC_REPLACEMENT_INVALID',
      'typescript_symbol replacement must be exactly one syntactically valid top-level statement.',
    );
  }
  const replacementStatement = replacementFile.statements[0];
  if (
    ts.isVariableStatement(replacementStatement) &&
    replacementStatement.declarationList.declarations.length !== 1
  ) {
    throw new PiAgentToolError(
      'SEMANTIC_REPLACEMENT_IDENTITY_MISMATCH',
      `Replacement for ${symbol} must contain exactly one variable declarator.`,
    );
  }
  const replacementNames = declarationNames(replacementStatement);
  if (replacementNames.length !== 1 || replacementNames[0] !== symbol) {
    throw new PiAgentToolError(
      'SEMANTIC_REPLACEMENT_IDENTITY_MISMATCH',
      `Replacement must contain exactly one declaration for the target symbol ${symbol}.`,
    );
  }
  const expectedIdentity = declarationIdentity(statement);
  const replacementIdentity = declarationIdentity(replacementStatement);
  if (!sameDeclarationIdentity(expectedIdentity, replacementIdentity)) {
    throw new PiAgentToolError(
      'SEMANTIC_REPLACEMENT_IDENTITY_MISMATCH',
      `Replacement for ${symbol} must preserve its declaration kind, modifiers, async/generator status, and variable declaration kind.`,
      { expected: expectedIdentity, received: replacementIdentity },
    );
  }
  const start = statement.getStart(sourceFile);
  const end = statement.end;
  return {
    content: `${content.slice(0, start)}${replacement}${content.slice(end)}`,
    startLine: lineNumberAt(sourceFile, start),
    endLine: lineNumberAt(sourceFile, Math.max(start, end - 1)),
  };
}

function replaceCssRule(
  filePath: string,
  content: string,
  selector: string,
  replacement: string,
): { content: string; startLine: number; endLine: number } {
  if (!/\.css$/i.test(filePath)) {
    throw new PiAgentToolError(
      'SEMANTIC_EDIT_FILE_TYPE_MISMATCH',
      'css_rule edits require a .css stylesheet.',
    );
  }
  let root: postcss.Root;
  try {
    root = postcss.parse(content, { from: filePath });
  } catch {
    throw new PiAgentToolError(
      'SEMANTIC_SOURCE_PARSE_FAILED',
      `Cannot safely edit ${filePath} because its CSS syntax is invalid.`,
    );
  }
  const matches: postcss.Rule[] = [];
  root.walkRules((rule) => {
    if (rule.selector.trim() === selector.trim()) matches.push(rule);
  });
  if (matches.length === 0) {
    throw new PiAgentToolError(
      'SEMANTIC_TARGET_NOT_FOUND',
      `CSS selector ${selector} was not found in ${filePath}. Query the exact existing selector; for a bounded multi-rule visual override, reuse beforeSha256 with kind=css_append instead of inventing a combined selector.`,
    );
  }
  if (matches.length > 1) {
    throw new PiAgentToolError(
      'SEMANTIC_TARGET_AMBIGUOUS',
      `CSS selector ${selector} occurs more than once in ${filePath}. Do not retry this semantic target or reread the unchanged file; reuse beforeSha256 and the last query_text_file line numbers with kind=line_range.`,
    );
  }
  let replacementRoot: postcss.Root;
  try {
    replacementRoot = postcss.parse(replacement, { from: `replacement-${filePath}` });
  } catch {
    throw new PiAgentToolError(
      'SEMANTIC_REPLACEMENT_INVALID',
      'css_rule replacement must contain one syntactically valid rule.',
    );
  }
  if (replacementRoot.nodes.length !== 1 || replacementRoot.nodes[0].type !== 'rule') {
    throw new PiAgentToolError(
      'SEMANTIC_REPLACEMENT_INVALID',
      'css_rule replacement must contain exactly one CSS rule.',
    );
  }
  const replacementRule = replacementRoot.nodes[0] as postcss.Rule;
  if (replacementRule.selector.trim() !== selector.trim()) {
    throw new PiAgentToolError(
      'SEMANTIC_REPLACEMENT_IDENTITY_MISMATCH',
      `Replacement selector must remain ${selector}.`,
    );
  }
  const match = matches[0];
  const start = match.source?.start?.offset;
  const end = match.source?.end?.offset;
  if (start === undefined || end === undefined) {
    throw new PiAgentToolError(
      'SEMANTIC_SOURCE_LOCATION_MISSING',
      `CSS parser did not provide a stable source range for ${selector}.`,
    );
  }
  return {
    content: `${content.slice(0, start)}${replacement}${content.slice(end)}`,
    startLine: match.source?.start?.line ?? 1,
    endLine: match.source?.end?.line ?? match.source?.start?.line ?? 1,
  };
}

function replaceLineRange(
  content: string,
  startLine: number,
  endLine: number,
  replacement: string,
): { content: string; startLine: number; endLine: number } {
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    throw new PiAgentToolError(
      'INVALID_TOOL_INPUT',
      'line_range requires positive integer startLine/endLine values with endLine greater than or equal to startLine.',
    );
  }
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const endsWithNewline = content.endsWith('\n');
  const lines = content.split(/\r?\n/);
  if (endsWithNewline) lines.pop();
  if (startLine > lines.length || endLine > lines.length) {
    throw new PiAgentToolError(
      'SEMANTIC_TARGET_NOT_FOUND',
      `Requested line range ${startLine}-${endLine} exceeds the ${lines.length}-line file.`,
    );
  }
  const replacementLines = replacement ? replacement.split(/\r?\n/) : [];
  const updated = [
    ...lines.slice(0, startLine - 1),
    ...replacementLines,
    ...lines.slice(endLine),
  ].join(newline);
  return {
    content: `${updated}${endsWithNewline ? newline : ''}`,
    startLine,
    endLine,
  };
}

function lineCount(content: string): number {
  const count = content.split(/\r?\n/).length;
  return content.endsWith('\n') ? count - 1 : count;
}

function cssSemanticNode(node: postcss.ChildNode): unknown {
  switch (node.type) {
    case 'rule':
      return ['rule', node.selector, node.nodes.map(cssSemanticNode)];
    case 'atrule':
      return [
        'atrule',
        node.name,
        node.params,
        node.nodes ? node.nodes.map(cssSemanticNode) : null,
      ];
    case 'decl':
      return ['decl', node.prop, node.value, node.important];
    case 'comment':
      return ['comment', node.text];
  }
}

function cssSemanticFingerprint(root: postcss.Root): string {
  return createHash('sha256')
    .update(JSON.stringify(root.nodes.map(cssSemanticNode)))
    .digest('hex');
}

function compactCssFormatting(root: postcss.Root): string {
  const compacted = root.clone();
  compacted.raws.after = '';
  compacted.walk((node) => {
    node.raws.before = '';
    if (node.type === 'decl') {
      node.raws.between = ':';
      return;
    }
    if (node.type === 'rule') {
      node.raws.between = '';
      node.raws.after = '';
      node.raws.semicolon = true;
      return;
    }
    if (node.type === 'atrule' && node.nodes) {
      node.raws.afterName = node.params ? ' ' : '';
      node.raws.between = '';
      node.raws.after = '';
      node.raws.semicolon = true;
    }
  });
  return compacted.nodes.map((node) => node.toString()).join('\n').trim();
}

function prepareCssAppend(
  filePath: string,
  replacement: string,
): { css: string; lines: number } {
  const normalized = replacement.trim();
  if (!normalized) {
    throw new PiAgentToolError(
      'SEMANTIC_REPLACEMENT_INVALID',
      'css_append replacement cannot be empty or whitespace-only.',
    );
  }
  const inputLines = lineCount(normalized);
  if (normalized.length > SEMANTIC_EDIT_CSS_APPEND_LIMITS.maxChars) {
    throw new PiAgentToolError(
      'SEMANTIC_TARGET_UNSAFE',
      `css_append is limited to ${SEMANTIC_EDIT_CSS_APPEND_LIMIT_TEXT}; append only the minimal override rules.`,
      {
        replacementChars: normalized.length,
        replacementLines: inputLines,
        maxChars: SEMANTIC_EDIT_CSS_APPEND_LIMITS.maxChars,
        maxLines: SEMANTIC_EDIT_CSS_APPEND_LIMITS.maxLines,
        maxNodes: SEMANTIC_EDIT_CSS_APPEND_LIMITS.maxNodes,
      },
    );
  }
  let parsed: postcss.Root;
  try {
    parsed = postcss.parse(normalized, { from: `append-${filePath}` });
  } catch {
    throw new PiAgentToolError(
      'SEMANTIC_REPLACEMENT_INVALID',
      'css_append replacement must contain syntactically valid CSS.',
    );
  }
  let nodeCount = 0;
  parsed.walk(() => {
    nodeCount += 1;
  });
  if (nodeCount > SEMANTIC_EDIT_CSS_APPEND_LIMITS.maxNodes) {
    throw new PiAgentToolError(
      'SEMANTIC_TARGET_UNSAFE',
      `css_append is limited to ${SEMANTIC_EDIT_CSS_APPEND_LIMIT_TEXT}; append only the minimal override rules.`,
      {
        replacementChars: normalized.length,
        replacementLines: inputLines,
        replacementNodes: nodeCount,
        maxChars: SEMANTIC_EDIT_CSS_APPEND_LIMITS.maxChars,
        maxLines: SEMANTIC_EDIT_CSS_APPEND_LIMITS.maxLines,
        maxNodes: SEMANTIC_EDIT_CSS_APPEND_LIMITS.maxNodes,
      },
    );
  }
  if (inputLines <= SEMANTIC_EDIT_CSS_APPEND_LIMITS.maxLines) {
    return { css: normalized, lines: inputLines };
  }

  const compacted = compactCssFormatting(parsed);
  let reparsed: postcss.Root;
  try {
    reparsed = postcss.parse(compacted, { from: `normalized-${filePath}` });
  } catch {
    throw new PiAgentToolError(
      'SEMANTIC_REPLACEMENT_INVALID',
      'css_append formatting normalization produced invalid CSS.',
    );
  }
  if (cssSemanticFingerprint(parsed) !== cssSemanticFingerprint(reparsed)) {
    throw new PiAgentToolError(
      'SEMANTIC_REPLACEMENT_INVALID',
      'css_append formatting normalization changed the parsed CSS semantics.',
    );
  }
  const compactedLines = lineCount(compacted);
  if (compactedLines > SEMANTIC_EDIT_CSS_APPEND_LIMITS.maxLines) {
    throw new PiAgentToolError(
      'SEMANTIC_TARGET_UNSAFE',
      `css_append is limited to ${SEMANTIC_EDIT_CSS_APPEND_LIMIT_TEXT}; append only the minimal override rules.`,
      {
        replacementChars: normalized.length,
        replacementLines: inputLines,
        normalizedLines: compactedLines,
        replacementNodes: nodeCount,
        maxChars: SEMANTIC_EDIT_CSS_APPEND_LIMITS.maxChars,
        maxLines: SEMANTIC_EDIT_CSS_APPEND_LIMITS.maxLines,
        maxNodes: SEMANTIC_EDIT_CSS_APPEND_LIMITS.maxNodes,
      },
    );
  }
  return { css: compacted, lines: compactedLines };
}

function appendCssOverride(
  filePath: string,
  content: string,
  replacement: string,
): { content: string; startLine: number; endLine: number } {
  if (!/\.css$/i.test(filePath)) {
    throw new PiAgentToolError(
      'SEMANTIC_EDIT_FILE_TYPE_MISMATCH',
      'css_append edits require a .css stylesheet.',
    );
  }
  const prepared = prepareCssAppend(filePath, replacement);
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const existing = content.replace(/\s+$/u, '');
  const startLine = lineCount(existing) + 2;
  return {
    content: `${existing}${newline}${newline}${prepared.css}${newline}`,
    startLine,
    endLine: startLine + prepared.lines - 1,
  };
}

function assertBoundedLineRange(
  content: string,
  startLine: number,
  endLine: number,
  replacement: string,
): void {
  if (!replacement.trim()) {
    throw new PiAgentToolError(
      'SEMANTIC_REPLACEMENT_INVALID',
      'line_range replacement cannot be empty or whitespace-only.',
    );
  }
  const totalLines = lineCount(content);
  const affectedLines = endLine - startLine + 1;
  const fractionalLimit = Math.max(1, Math.ceil(totalLines * DEFAULT_MAX_LINE_RANGE_FRACTION));
  const allowedLines = totalLines <= 20
    ? Math.max(1, totalLines - 1)
    : Math.min(DEFAULT_MAX_LINE_RANGE_LINES, fractionalLimit);
  if (affectedLines > allowedLines) {
    throw new PiAgentToolError(
      'SEMANTIC_TARGET_UNSAFE',
      `line_range may replace at most ${allowedLines} of ${totalLines} lines; use a named TypeScript declaration or CSS rule, or kind=css_append for a bounded multi-rule stylesheet override.`,
      { affectedLines, allowedLines, totalLines },
    );
  }
}

function hasDefaultExport(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some((statement) => {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    return (modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
  });
}

function hasUseClientDirective(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some((statement) =>
    ts.isExpressionStatement(statement) &&
    ts.isStringLiteral(statement.expression) &&
    statement.expression.text === 'use client');
}

function validateEditedDocument(filePath: string, before: string, content: string): void {
  if (content === before) {
    throw new PiAgentToolError(
      'SEMANTIC_NO_CHANGE',
      `The semantic edit does not change ${filePath}.`,
    );
  }
  if (/\.tsx?$/i.test(filePath)) {
    const originalFile = ts.createSourceFile(
      filePath,
      before,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(filePath),
    );
    const editedFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(filePath),
    );
    if (sourceParseDiagnostics(editedFile).length > 0) {
      throw new PiAgentToolError(
        'SEMANTIC_REPLACEMENT_INVALID',
        `The semantic edit would leave ${filePath} with invalid TypeScript syntax.`,
      );
    }
    if (hasDefaultExport(originalFile) && !hasDefaultExport(editedFile)) {
      throw new PiAgentToolError(
        'SEMANTIC_REPLACEMENT_IDENTITY_MISMATCH',
        `The semantic edit must preserve the default export in ${filePath}.`,
      );
    }
    if (hasUseClientDirective(originalFile) && !hasUseClientDirective(editedFile)) {
      throw new PiAgentToolError(
        'SEMANTIC_REPLACEMENT_IDENTITY_MISMATCH',
        `The semantic edit must preserve the use client directive in ${filePath}.`,
      );
    }
    return;
  }
  if (/\.css$/i.test(filePath)) {
    try {
      postcss.parse(content, { from: filePath });
    } catch {
      throw new PiAgentToolError(
        'SEMANTIC_REPLACEMENT_INVALID',
        `The semantic edit would leave ${filePath} with invalid CSS syntax.`,
      );
    }
    if (!content.trim()) {
      throw new PiAgentToolError(
        'SEMANTIC_REPLACEMENT_INVALID',
        `The semantic edit cannot empty ${filePath}.`,
      );
    }
  }
}

function applySemanticEdit(
  input: SemanticEditInput,
  content: string,
): { content: string; startLine: number; endLine: number; target: string } {
  assertSemanticSourceFile(input.path);
  let edited: { content: string; startLine: number; endLine: number; target: string };
  switch (input.kind) {
    case 'typescript_symbol': {
      edited = {
        ...replaceTypeScriptSymbol(input.path, content, input.symbol, input.replacement),
        target: input.symbol,
      };
      break;
    }
    case 'css_rule': {
      edited = {
        ...replaceCssRule(input.path, content, input.selector, input.replacement),
        target: input.selector,
      };
      break;
    }
    case 'css_append': {
      edited = {
        ...appendCssOverride(input.path, content, input.replacement),
        target: 'append',
      };
      break;
    }
    case 'line_range': {
      assertBoundedLineRange(content, input.startLine, input.endLine, input.replacement);
      edited = {
        ...replaceLineRange(content, input.startLine, input.endLine, input.replacement),
        target: `${input.startLine}-${input.endLine}`,
      };
      break;
    }
  }
  validateEditedDocument(input.path, content, edited.content);
  return edited;
}

export function createSemanticEditTool(
  options: PiAgentSemanticEditToolOptions,
): PiAgentTool<SemanticEditInput, SemanticEditOutput> {
  const maxReplacementChars = options.maxReplacementChars ?? DEFAULT_MAX_REPLACEMENT_CHARS;
  const allowedKinds = options.allowedKinds?.length
    ? [...new Set(options.allowedKinds)]
    : [...ALL_SEMANTIC_EDIT_KINDS];
  if (allowedKinds.length === 0) {
    throw new Error('semantic_edit requires at least one allowed edit kind.');
  }
  const terminalSubmissionHint = options.requireTerminalSubmissionAfterSuccess
    ? ` ${PREPARED_CUSTOM_SEMANTIC_EDIT_SUBMIT_HINT}`
    : '';
  const preparedKindHint = allowedKinds.length === 1 && allowedKinds[0] === 'css_append'
    ? ' This prepared layout surface accepts only kind=css_append; append minimal valid CSS rules and do not use line_range, css_rule, or TypeScript replacements.'
    : '';
  let policyPromise: Promise<PiAgentWorkspacePolicy> | undefined;
  const policy = () => policyPromise ??= PiAgentWorkspacePolicy.create({
    workspaceRoot: options.workspaceRoot,
    allowedWriteGlobs: options.allowedWriteGlobs,
    includeDefaultWriteGlobs: options.includeDefaultWriteGlobs,
  });
  return {
    name: 'semantic_edit',
    description: `Versioned edit for ${allowedKinds.join(', ')}. Obtain beforeSha256 from query_text_file. For broad stylesheet-only restyling use css_append, never a whole-file line_range or invented combined selector. A css_append replacement must not exceed ${SEMANTIC_EDIT_CSS_APPEND_LIMIT_TEXT}.${preparedKindHint}${terminalSubmissionHint}`,
    effect: 'workspace_write',
    idempotency: 'reconcile_required',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative source or stylesheet path.' },
        kind: { type: 'string', enum: allowedKinds },
        beforeSha256: { type: 'string', description: 'SHA-256 returned by the preceding targeted read.' },
        symbol: { type: 'string', description: 'Required only for typescript_symbol.' },
        selector: { type: 'string', description: 'Required only for css_rule.' },
        startLine: { type: 'integer', minimum: 1, description: 'Required only for line_range.' },
        endLine: { type: 'integer', minimum: 1, description: 'Required only for line_range.' },
        replacement: { type: 'string', description: allowedKinds.length === 1 && allowedKinds[0] === 'css_append'
          ? `CSS override rules only; limited to ${SEMANTIC_EDIT_CSS_APPEND_LIMIT_TEXT}.`
          : `Complete replacement declaration/rule/range, or CSS override rules limited to ${SEMANTIC_EDIT_CSS_APPEND_LIMIT_TEXT} for css_append.` },
      },
      required: ['path', 'kind', 'beforeSha256', 'replacement'],
      additionalProperties: false,
    },
    parseInput: (value) => parseInput(value, maxReplacementChars, allowedKinds),
    execute: (input, context) => executePiAgentTool(
      context.signal,
      options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      async (signal) => {
        throwIfAborted(signal);
        const workspacePolicy = await policy();
        await workspacePolicy.resolveWritePath(input.path);
        const resolved = await workspacePolicy.resolveReadPath(input.path);
        const stat = await fs.stat(resolved.canonicalPath);
        const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_SEMANTIC_FILE_BYTES;
        if (!stat.isFile()) {
          throw new PiAgentToolError('NOT_A_FILE', `Expected a file: ${resolved.relativePath}.`);
        }
        if (stat.size > maxFileBytes) {
          throw new PiAgentToolError(
            'FILE_TOO_LARGE',
            `${resolved.relativePath} exceeds the ${maxFileBytes}-byte semantic edit limit.`,
          );
        }
        const buffer = await fs.readFile(resolved.canonicalPath, { signal });
        if (buffer.includes(0)) {
          throw new PiAgentToolError('BINARY_FILE_DENIED', `Cannot edit binary file ${resolved.relativePath}.`);
        }
        const beforeSha256 = createHash('sha256').update(buffer).digest('hex');
        if (beforeSha256 !== input.beforeSha256) {
          throw new PiAgentToolError(
            'WORKSPACE_WRITE_CONFLICT',
            `The target changed after it was read: ${resolved.relativePath}. Query it again before editing.`,
            { expectedSha256: input.beforeSha256, actualSha256: beforeSha256 },
          );
        }
        const edited = applySemanticEdit(input, buffer.toString('utf8'));
        const updated = Buffer.from(edited.content, 'utf8');
        const write = await writePiAgentWorkspaceBatch({
          policy: workspacePolicy,
          files: [{
            relativePath: input.path,
            content: updated,
            expectedBeforeSha256: beforeSha256,
          }],
          maxBytesPerFile: options.maxWriteBytes ?? maxFileBytes,
          maxTotalBytes: options.maxWriteBytes ?? maxFileBytes,
          signal,
          resourceLockWaitTimeoutMs: options.resourceLockWaitTimeoutMs,
          lockIdentity: { runId: context.runId, operationId: context.operationId },
          commitWorkspaceMutation: context.commitWorkspaceMutation,
        });
        const file = write.files[0];
        const data: SemanticEditOutput = {
          path: file.path,
          kind: input.kind,
          target: edited.target,
          startLine: edited.startLine,
          endLine: edited.endLine,
          beforeSha256,
          afterSha256: file.afterSha256,
          bytes: file.bytes,
        };
        return {
          ok: true,
          data,
          content: `Semantically edited ${file.path} (${input.kind} ${edited.target}, lines ${edited.startLine}-${edited.endLine}).${terminalSubmissionHint}`,
        };
      },
    ),
  };
}

export const __semanticEditTesting = {
  applySemanticEdit,
  replaceCssRule,
  replaceLineRange,
  replaceTypeScriptSymbol,
};
