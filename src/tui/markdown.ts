import type {
  AlignType,
  Blockquote,
  Code,
  Heading,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Table,
} from 'mdast';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import stringWidth from 'string-width';

import { positionedEmojiTransformer } from '../core/source-map.js';
import { sanitizeTerminalText } from './security.js';
import {
  createTerminalTheme,
  fitTerminalLines,
  highlightTerminalCode,
  padTerminalText,
  resolveTerminalWidth,
  truncateTerminalText,
  wrapTerminalText,
  type TerminalTheme,
} from './terminal.js';
import type { TuiRenderOptions, TuiRenderResult } from './types.js';

const MAX_RENDER_DEPTH = 32;
const MAX_TABLE_COLUMNS = 32;

interface BorderSet {
  bottomIntersection: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  intersection: string;
  left: string;
  middleLeft: string;
  middleRight: string;
  right: string;
  topLeft: string;
  topIntersection: string;
  topRight: string;
  vertical: string;
}

interface RenderState {
  borders: BorderSet;
  renderMermaid: (code: string) => Promise<TuiRenderResult>;
  theme: TerminalTheme;
  unicode: boolean;
  warnings: string[];
  omittedFencedCodeLanguages: ReadonlySet<string>;
}

const UNICODE_BORDERS: BorderSet = {
  bottomIntersection: '┴',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  intersection: '┼',
  left: '├',
  middleLeft: '├',
  middleRight: '┤',
  right: '┤',
  topLeft: '┌',
  topIntersection: '┬',
  topRight: '┐',
  vertical: '│',
};

const ASCII_BORDERS: BorderSet = {
  bottomIntersection: '+',
  bottomLeft: '+',
  bottomRight: '+',
  horizontal: '-',
  intersection: '+',
  left: '+',
  middleLeft: '+',
  middleRight: '+',
  right: '+',
  topLeft: '+',
  topIntersection: '+',
  topRight: '+',
  vertical: '|',
};

export async function renderMarkdownMermaidFallback(
  markdown: string,
  renderMermaid: (code: string) => Promise<TuiRenderResult>,
  options: TuiRenderOptions = {},
): Promise<TuiRenderResult> {
  const safeMarkdown = sanitizeTerminalText(markdown);
  const processor = remark()
    .use(remarkGfm)
    .use(() => positionedEmojiTransformer(safeMarkdown));
  const tree = await processor.run(processor.parse(safeMarkdown)) as Root;
  const width = resolveTerminalWidth(options.width);
  const state: RenderState = {
    borders: options.unicode === false ? ASCII_BORDERS : UNICODE_BORDERS,
    renderMermaid,
    theme: createTerminalTheme(options.color === true),
    unicode: options.unicode !== false,
    warnings: [],
    omittedFencedCodeLanguages: new Set(
      (options.omitFencedCodeLanguages ?? []).map((language) =>
        language.trim().toLowerCase(),
      ),
    ),
  };
  const lines = await renderBlocks(tree.children, width, state, 0);
  const output = fitTerminalLines(lines.join('\n'), width).join('\n');

  return {
    output,
    backend: 'beautiful-mermaid',
    warnings: state.warnings,
  };
}

async function renderBlocks(
  nodes: readonly RootContent[],
  width: number,
  state: RenderState,
  depth: number,
): Promise<string[]> {
  if (depth > MAX_RENDER_DEPTH) {
    if (!state.warnings.includes('Markdown nesting exceeded the safety limit.')) {
      state.warnings.push('Markdown nesting exceeded the safety limit.');
    }
    return wrapTerminalText('[nested content omitted]', width);
  }

  const lines: string[] = [];

  for (const node of nodes) {
    const block = await renderBlock(node, width, state, depth);
    if (block.length === 0) continue;
    if (lines.length > 0 && lines.at(-1) !== '') lines.push('');
    lines.push(...block);
  }

  return lines;
}

async function renderBlock(
  node: RootContent,
  width: number,
  state: RenderState,
  depth: number,
): Promise<string[]> {
  switch (node.type) {
    case 'heading':
      return renderHeading(node, width, state);
    case 'paragraph':
      return renderParagraph(node, width, state);
    case 'list':
      return renderList(node, width, state, depth + 1);
    case 'blockquote':
      return renderBlockquote(node, width, state, depth + 1);
    case 'thematicBreak':
      return [state.borders.horizontal.repeat(width)];
    case 'code':
      return renderCode(node, width, state);
    case 'table':
      return renderTable(node, width, state);
    case 'yaml':
      return renderCodeBox(node.value, 'yaml', width, state);
    case 'html':
    case 'definition':
      return [];
    case 'footnoteDefinition': {
      const label = state.theme.color
        ? state.theme.styles.bold(`[${node.identifier}]`)
        : `[${node.identifier}]`;
      const content = await renderBlocks(node.children, width, state, depth + 1);
      return prefixLines(content, `${label} `, width);
    }
    default:
      if ('children' in node && Array.isArray(node.children)) {
        return renderBlocks(
          node.children as RootContent[],
          width,
          state,
          depth + 1,
        );
      }
      if ('value' in node && typeof node.value === 'string') {
        return wrapTerminalText(node.value, width);
      }
      return [];
  }
}

function renderHeading(
  node: Heading,
  width: number,
  state: RenderState,
): string[] {
  const raw = renderInline(node.children, state).trim();
  const { styles } = state.theme;
  const styled = state.theme.color
    ? node.depth === 1
      ? styles.bold.cyan(raw)
      : node.depth === 2
        ? styles.bold.blue(raw)
        : node.depth === 3
          ? styles.bold.yellow(raw)
          : styles.bold(raw)
    : raw;

  if (node.depth <= 2) {
    const lines = wrapTerminalText(styled, width);
    const rule = (node.depth === 1
      ? state.unicode
        ? '═'
        : '='
      : state.borders.horizontal
    ).repeat(width);
    return [...lines, rule];
  }

  const unicodePrefixes = ['◆ ', '◇ ', '› ', '· '];
  const asciiPrefixes = ['== ', '-- ', '> ', '. '];
  const prefix = (state.unicode ? unicodePrefixes : asciiPrefixes)[
    node.depth - 3
  ];
  return wrapWithPrefix(styled, prefix, width);
}

function renderParagraph(
  node: Paragraph,
  width: number,
  state: RenderState,
): string[] {
  return wrapTerminalText(renderInline(node.children, state).trim(), width);
}

function renderInline(
  nodes: readonly PhrasingContent[],
  state: RenderState,
): string {
  return nodes.map((node) => renderInlineNode(node, state)).join('');
}

function renderInlineNode(node: PhrasingContent, state: RenderState): string {
  const { styles } = state.theme;

  switch (node.type) {
    case 'text':
      return node.value.replace(/\s+/g, ' ');
    case 'break':
      return '\n';
    case 'strong': {
      const value = renderInline(node.children, state);
      return state.theme.color ? styles.bold(value) : `*${value}*`;
    }
    case 'emphasis': {
      const value = renderInline(node.children, state);
      return state.theme.color ? styles.italic(value) : `/${value}/`;
    }
    case 'delete': {
      const value = renderInline(node.children, state);
      return state.theme.color ? styles.strikethrough(value) : `~${value}~`;
    }
    case 'inlineCode':
      return state.theme.color
        ? styles.yellow(node.value)
        : `[${node.value.replace(/\s+/g, ' ')}]`;
    case 'link': {
      const label = renderInline(node.children, state);
      const url = sanitizeTerminalText(node.url).replace(/\s+/g, ' ').trim();
      if (!url) return label;
      return state.theme.color
        ? `${styles.cyan.underline(label)} ${styles.dim(`(${url})`)}`
        : `${label} (${url})`;
    }
    case 'linkReference':
      return renderInline(node.children, state);
    case 'image': {
      const label = node.alt || 'image';
      const url = sanitizeTerminalText(node.url).replace(/\s+/g, ' ').trim();
      return url ? `${label} (${url})` : label;
    }
    case 'imageReference':
      return node.alt || 'image';
    case 'footnoteReference':
      return `[${node.identifier}]`;
    case 'html':
      return '';
    default:
      return '';
  }
}

async function renderList(
  node: List,
  width: number,
  state: RenderState,
  depth: number,
): Promise<string[]> {
  const lines: string[] = [];
  const start = node.start ?? 1;

  for (const [index, item] of node.children.entries()) {
    const marker = renderListMarker(node, item, start + index, state);
    const markerWidth = stringWidth(marker);
    const contentWidth = Math.max(1, width - markerWidth);
    const children = item.children as RootContent[];
    const first = children[0];

    if (first?.type === 'paragraph') {
      const paragraph = renderParagraph(first, contentWidth, state);
      lines.push(`${marker}${paragraph[0] ?? ''}`);
      lines.push(
        ...paragraph.slice(1).map((line) => `${' '.repeat(markerWidth)}${line}`),
      );
    } else if (first) {
      const block = await renderBlock(first, contentWidth, state, depth);
      lines.push(`${marker}${block[0] ?? ''}`);
      lines.push(
        ...block.slice(1).map((line) => `${' '.repeat(markerWidth)}${line}`),
      );
    } else {
      lines.push(marker.trimEnd());
    }

    for (const child of children.slice(1)) {
      if (child.type === 'list') {
        const nested = await renderList(
          child,
          Math.max(1, width - 2),
          state,
          depth + 1,
        );
        lines.push(...nested.map((line) => `  ${line}`));
        continue;
      }

      const continuation = await renderBlock(
        child,
        contentWidth,
        state,
        depth + 1,
      );
      lines.push(
        ...continuation.map((line) => `${' '.repeat(markerWidth)}${line}`),
      );
    }
  }

  return lines;
}

function renderListMarker(
  list: List,
  item: ListItem,
  number: number,
  state: RenderState,
): string {
  if (typeof item.checked === 'boolean') {
    if (state.unicode) return item.checked ? '☑ ' : '☐ ';
    return item.checked ? '[x] ' : '[ ] ';
  }

  if (list.ordered) return `${number}. `;
  return state.unicode ? '• ' : '- ';
}

async function renderBlockquote(
  node: Blockquote,
  width: number,
  state: RenderState,
  depth: number,
): Promise<string[]> {
  const prefix = `${state.borders.vertical} `;
  const inner = await renderBlocks(
    node.children,
    Math.max(1, width - stringWidth(prefix)),
    state,
    depth,
  );
  return inner.map((line) => (line ? `${prefix}${line}` : state.borders.vertical));
}

async function renderCode(
  node: Code,
  width: number,
  state: RenderState,
): Promise<string[]> {
  const language = node.lang?.trim().toLowerCase() || 'text';

  if (state.omittedFencedCodeLanguages.has(language)) return [];

  if (language === 'mermaid') {
    const result = await state.renderMermaid(node.value);
    state.warnings.push(...result.warnings.map(sanitizeTerminalText));

    if (result.backend === 'beautiful-mermaid') {
      return fitTerminalLines(sanitizeTerminalText(result.output), width).filter(
        (line, index, all) => line || index < all.length - 1,
      );
    }
  }

  return renderCodeBox(node.value, language, width, state);
}

function renderCodeBox(
  code: string,
  language: string,
  width: number,
  state: RenderState,
): string[] {
  if (width < 5) {
    return fitTerminalLines(code, width);
  }

  const contentWidth = width - 4;
  const highlighted = highlightTerminalCode(code, language, state.theme).output;
  const lines = highlighted.split('\n').flatMap((line) =>
    wrapTerminalText(line, contentWidth, {
      trim: false,
      wordWrap: false,
    }),
  );
  const safeLabel = sanitizeTerminalText(language).replace(/\s+/g, ' ').trim();
  const labelWidth = Math.max(0, width - 6);
  const label = truncateTerminalText(safeLabel || 'text', labelWidth);
  const topPrefix = `${state.borders.topLeft}${state.borders.horizontal} ${label} `;
  const topFill = Math.max(0, width - stringWidth(topPrefix) - 1);
  const top = `${topPrefix}${state.borders.horizontal.repeat(topFill)}${state.borders.topRight}`;
  const bottom = `${state.borders.bottomLeft}${state.borders.horizontal.repeat(width - 2)}${state.borders.bottomRight}`;
  const body = (lines.length > 0 ? lines : ['']).map(
    (line) =>
      `${state.borders.vertical} ${padTerminalText(line, contentWidth)} ${state.borders.vertical}`,
  );

  return [top, ...body, bottom];
}

function renderTable(
  node: Table,
  width: number,
  state: RenderState,
): string[] {
  const rows = node.children.map((row) =>
    row.children.map((cell) => renderInline(cell.children, state).trim()),
  );
  const columnCount = Math.min(
    MAX_TABLE_COLUMNS,
    Math.max(0, ...rows.map((row) => row.length)),
  );

  if (columnCount === 0) return [];
  if (width < columnCount * 4 + 1) {
    return renderStackedTable(rows, width, state);
  }

  const overhead = columnCount * 3 + 1;
  const available = width - overhead;
  const preferred = Array.from({ length: columnCount }, (_, column) =>
    Math.max(
      1,
      ...rows.map((row) => stringWidth(row[column] ?? '')),
    ),
  );
  const columnWidths = Array.from({ length: columnCount }, () => 1);
  let remaining = available - columnCount;

  while (remaining > 0) {
    let selected = -1;
    let selectedNeed = 0;

    for (let column = 0; column < columnCount; column++) {
      const need = preferred[column] - columnWidths[column];
      if (need > selectedNeed) {
        selected = column;
        selectedNeed = need;
      }
    }

    if (selected < 0) break;
    columnWidths[selected] += 1;
    remaining -= 1;
  }

  const top = renderTableBorder(
    state.borders.topLeft,
    state.borders.topIntersection,
    state.borders.topRight,
    columnWidths,
    state,
  );
  const separator = renderTableBorder(
    state.borders.middleLeft,
    state.borders.intersection,
    state.borders.middleRight,
    columnWidths,
    state,
  );
  const bottom = renderTableBorder(
    state.borders.bottomLeft,
    state.borders.bottomIntersection,
    state.borders.bottomRight,
    columnWidths,
    state,
  );
  const lines = [top];

  for (const [rowIndex, row] of rows.entries()) {
    const cells = columnWidths.map((columnWidth, column) => {
      let value = row[column] ?? '';
      if (rowIndex === 0 && state.theme.color) {
        value = state.theme.styles.bold(value);
      }
      return wrapTerminalText(value, columnWidth);
    });
    const height = Math.max(1, ...cells.map((cell) => cell.length));

    for (let lineIndex = 0; lineIndex < height; lineIndex++) {
      const content = columnWidths.map((columnWidth, column) => {
        const alignment = normalizeAlignment(node.align?.[column]);
        return ` ${padTerminalText(cells[column][lineIndex] ?? '', columnWidth, alignment)} `;
      });
      lines.push(
        `${state.borders.vertical}${content.join(state.borders.vertical)}${state.borders.vertical}`,
      );
    }

    if (rowIndex < rows.length - 1) lines.push(separator);
  }

  lines.push(bottom);
  return lines;
}

function renderTableBorder(
  left: string,
  intersection: string,
  right: string,
  widths: readonly number[],
  state: RenderState,
): string {
  return `${left}${widths
    .map((width) => state.borders.horizontal.repeat(width + 2))
    .join(intersection)}${right}`;
}

function renderStackedTable(
  rows: readonly string[][],
  width: number,
  state: RenderState,
): string[] {
  if (width < 5) {
    return rows.flatMap((row) => fitTerminalLines(row.join(' '), width));
  }

  const headers = rows[0] ?? [];
  const contentWidth = width - 4;
  const top = `${state.borders.topLeft}${state.borders.horizontal.repeat(width - 2)}${state.borders.topRight}`;
  const separator = `${state.borders.middleLeft}${state.borders.horizontal.repeat(width - 2)}${state.borders.middleRight}`;
  const bottom = `${state.borders.bottomLeft}${state.borders.horizontal.repeat(width - 2)}${state.borders.bottomRight}`;
  const lines = [top];

  for (const [rowIndex, row] of rows.slice(1).entries()) {
    const value = row
      .map((cell, column) => `${headers[column] || `Column ${column + 1}`}: ${cell}`)
      .join('; ');
    for (const line of wrapTerminalText(value, contentWidth)) {
      lines.push(
        `${state.borders.vertical} ${padTerminalText(line, contentWidth)} ${state.borders.vertical}`,
      );
    }
    if (rowIndex < rows.length - 2) lines.push(separator);
  }

  lines.push(bottom);
  return lines;
}

function normalizeAlignment(
  alignment: AlignType | null | undefined,
): 'center' | 'left' | 'right' {
  return alignment === 'center' || alignment === 'right' ? alignment : 'left';
}

function wrapWithPrefix(
  value: string,
  prefix: string,
  width: number,
): string[] {
  const prefixWidth = stringWidth(prefix);
  if (prefixWidth >= width) {
    return fitTerminalLines(`${prefix}${value}`, width);
  }

  const lines = wrapTerminalText(value, width - prefixWidth);
  return lines.map((line, index) =>
    index === 0 ? `${prefix}${line}` : `${' '.repeat(prefixWidth)}${line}`,
  );
}

function prefixLines(lines: string[], prefix: string, width: number): string[] {
  const prefixWidth = stringWidth(prefix);
  if (prefixWidth >= width) return fitTerminalLines(`${prefix}${lines.join(' ')}`, width);
  return lines.map((line) => `${prefix}${truncateTerminalText(line, width - prefixWidth)}`);
}
