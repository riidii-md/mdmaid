import type {
  Code,
  Html,
  InlineCode,
  PhrasingContent,
  Root,
  RootContent,
  Text,
} from 'mdast';
import { remark } from 'remark';
import gfm from 'remark-gfm';
import { get as getEmoji } from 'node-emoji';
import { visit } from 'unist-util-visit';

export const MARKDOWN_SOURCE_MAP_VERSION = 1 as const;
export const MARKDOWN_SOURCE_COORDINATE_SYSTEM = 'utf16-code-units' as const;

const DEFAULT_CONTEXT_LENGTH = 128;
const EMOJI_SHORTCODE = /:\+1:|:-1:|:[\w-]+:/g;

export interface MarkdownSourcePointV1 {
  offset: number;
  line: number;
  column: number;
}

export interface MarkdownSourceSegmentV1 {
  ref: string;
  blockRef: string;
  text: string;
  sourceStart: MarkdownSourcePointV1;
  sourceEnd: MarkdownSourcePointV1;
  mapping: 'identity' | 'atomic';
}

export interface MarkdownLogicalLineV1 {
  ref: string;
  text: string;
  segmentRefs: string[];
  sourceStart: MarkdownSourcePointV1;
  sourceEnd: MarkdownSourcePointV1;
}

export interface MarkdownSourceExclusionV1 {
  sourceStart: MarkdownSourcePointV1;
  sourceEnd: MarkdownSourcePointV1;
  reason: 'generated' | 'omitted' | 'raw-html';
}

export interface MarkdownSourceMapV1 {
  version: typeof MARKDOWN_SOURCE_MAP_VERSION;
  coordinateSystem: typeof MARKDOWN_SOURCE_COORDINATE_SYSTEM;
  sourceLength: number;
  segments: MarkdownSourceSegmentV1[];
  logicalLines: MarkdownLogicalLineV1[];
  exclusions: MarkdownSourceExclusionV1[];
}

export interface MarkdownSelectionBoundaryV1 {
  ref: string;
  offset: number;
}

export interface MarkdownSelectionWitnessV1 {
  start: MarkdownSelectionBoundaryV1;
  end: MarkdownSelectionBoundaryV1;
}

export interface MarkdownTextAnchorV1 {
  kind: 'markdown-v1';
  start: MarkdownSourcePointV1;
  end: MarkdownSourcePointV1;
  exact: string;
  prefix: string;
  suffix: string;
}

export interface MarkdownSourceMapOptions {
  omitFencedCodeLanguages?: readonly string[];
}

interface BuiltMarkdownSourceMap {
  map: MarkdownSourceMapV1;
  segmentByNode: WeakMap<object, MarkdownSourceSegmentV1>;
  segmentsByNode: WeakMap<object, MarkdownSourceSegmentV1[]>;
}

interface MutableBuildState {
  blockCount: number;
  segmentCount: number;
  segments: MarkdownSourceSegmentV1[];
  exclusions: MarkdownSourceExclusionV1[];
  segmentByNode: WeakMap<object, MarkdownSourceSegmentV1>;
  segmentsByNode: WeakMap<object, MarkdownSourceSegmentV1[]>;
}

type PositionedNode = RootContent | PhrasingContent;

export async function createMarkdownSourceMap(
  markdown: string,
  options: MarkdownSourceMapOptions = {},
): Promise<MarkdownSourceMapV1> {
  const processor = remark()
    .use(gfm)
    .use(() => positionedEmojiTransformer(markdown));
  const tree = (await processor.run(processor.parse(markdown))) as Root;
  return buildMarkdownSourceMap(tree, markdown, options).map;
}

export function buildMarkdownSourceMap(
  tree: Root,
  markdown: string,
  options: MarkdownSourceMapOptions = {},
  initialExclusions: readonly MarkdownSourceExclusionV1[] = [],
): BuiltMarkdownSourceMap {
  const state: MutableBuildState = {
    blockCount: 0,
    segmentCount: 0,
    segments: [],
    exclusions: [...initialExclusions],
    segmentByNode: new WeakMap(),
    segmentsByNode: new WeakMap(),
  };
  const omitted = new Set(
    (options.omitFencedCodeLanguages ?? []).map(normalizeLanguage),
  );

  collectBlocks(tree.children, markdown, omitted, state);

  const logicalLines = buildLogicalLines(state.segments);
  return {
    map: {
      version: MARKDOWN_SOURCE_MAP_VERSION,
      coordinateSystem: MARKDOWN_SOURCE_COORDINATE_SYSTEM,
      sourceLength: markdown.length,
      segments: state.segments,
      logicalLines,
      exclusions: state.exclusions.sort(
        (left, right) => left.sourceStart.offset - right.sourceStart.offset,
      ),
    },
    segmentByNode: state.segmentByNode,
    segmentsByNode: state.segmentsByNode,
  };
}

export function positionedEmojiTransformer(markdown: string): (tree: Root) => void {
  return (tree: Root) => {
    visit(tree, 'text', (node: Text, index: number | undefined, parent: any) => {
      if (!parent || typeof index !== 'number' || !node.position) return;
      const matches = [...node.value.matchAll(EMOJI_SHORTCODE)].filter((match) =>
        Boolean(getEmoji(match[0])),
      );
      if (matches.length === 0) return;

      const sourceStart = node.position.start.offset;
      const sourceEnd = node.position.end.offset;
      if (
        typeof sourceStart !== 'number' ||
        !Number.isInteger(sourceStart) ||
        typeof sourceEnd !== 'number' ||
        !Number.isInteger(sourceEnd)
      ) return;
      const sourceText = markdown.slice(sourceStart, sourceEnd);
      const sourceMatches = [...sourceText.matchAll(EMOJI_SHORTCODE)].filter(
        (match) => Boolean(getEmoji(match[0])),
      );
      if (
        sourceMatches.length !== matches.length ||
        sourceMatches.some((match, matchIndex) => match[0] !== matches[matchIndex]?.[0])
      ) {
        const transformed = node.value.replace(
          EMOJI_SHORTCODE,
          (shortcode) => getEmoji(shortcode) ?? shortcode,
        );
        parent.children.splice(
          index,
          1,
          positionedText(transformed, markdown, sourceStart, sourceEnd),
        );
        return index + 1;
      }
      const replacements: Text[] = [];
      let valueCursor = 0;
      let sourceCursor = sourceStart;
      for (const [matchOrdinal, match] of matches.entries()) {
        const sourceMatch = sourceMatches[matchOrdinal];
        if (!sourceMatch) continue;
        const matchIndex = match.index;
        const sourceMatchStart = sourceStart + sourceMatch.index;
        if (matchIndex > valueCursor) {
          replacements.push(
            positionedText(
              node.value.slice(valueCursor, matchIndex),
              markdown,
              sourceCursor,
              sourceMatchStart,
            ),
          );
        }
        const emoji = getEmoji(match[0]);
        if (!emoji) continue;
        replacements.push(
          positionedText(
            emoji,
            markdown,
            sourceMatchStart,
            sourceMatchStart + sourceMatch[0].length,
          ),
        );
        valueCursor = matchIndex + match[0].length;
        sourceCursor = sourceMatchStart + sourceMatch[0].length;
      }
      if (valueCursor < node.value.length) {
        replacements.push(
          positionedText(
            node.value.slice(valueCursor),
            markdown,
            sourceCursor,
            sourceEnd,
          ),
        );
      }
      parent.children.splice(index, 1, ...replacements);
      return index + replacements.length;
    });
  };
}

export function resolveMarkdownSelection(
  markdown: string,
  sourceMap: MarkdownSourceMapV1,
  selection: MarkdownSelectionWitnessV1,
  contextLength = DEFAULT_CONTEXT_LENGTH,
): MarkdownTextAnchorV1 {
  if (
    sourceMap.version !== MARKDOWN_SOURCE_MAP_VERSION ||
    sourceMap.coordinateSystem !== MARKDOWN_SOURCE_COORDINATE_SYSTEM ||
    sourceMap.sourceLength !== markdown.length
  ) {
    throw new Error('Markdown source map does not match the authoritative source.');
  }

  const startIndex = sourceMap.segments.findIndex(
    (segment) => segment.ref === selection.start.ref,
  );
  const endIndex = sourceMap.segments.findIndex(
    (segment) => segment.ref === selection.end.ref,
  );
  if (startIndex < 0 || endIndex < 0) {
    throw new Error('Markdown selection references an unknown mapped segment.');
  }
  if (startIndex > endIndex) {
    throw new Error('Markdown selection boundaries are reversed.');
  }

  const startSegment = sourceMap.segments[startIndex];
  const endSegment = sourceMap.segments[endIndex];
  if (startSegment.blockRef !== endSegment.blockRef) {
    throw new Error('Markdown selection must stay within the same selectable block.');
  }

  validateBoundary(startSegment, selection.start.offset, 'start');
  validateBoundary(endSegment, selection.end.offset, 'end');
  if (
    startIndex === endIndex &&
    selection.start.offset >= selection.end.offset
  ) {
    throw new Error('Markdown selection must contain at least one character.');
  }

  const selectedSegments = sourceMap.segments.slice(startIndex, endIndex + 1);
  if (selectedSegments.some((segment) => segment.blockRef !== startSegment.blockRef)) {
    throw new Error('Markdown selection must stay within the same selectable block.');
  }

  const exact = selectedSegments
    .map((segment, index) => {
      const start = index === 0 ? selection.start.offset : 0;
      const end =
        index === selectedSegments.length - 1
          ? selection.end.offset
          : segment.text.length;
      return segment.text.slice(start, end);
    })
    .join('');
  if (!exact) {
    throw new Error('Markdown selection must contain at least one character.');
  }

  const sourceStartOffset = resolveSourceBoundary(
    startSegment,
    selection.start.offset,
  );
  const sourceEndOffset = resolveSourceBoundary(endSegment, selection.end.offset);
  if (
    sourceMap.exclusions.some((exclusion) =>
      exclusion.sourceStart.offset < sourceEndOffset &&
      exclusion.sourceEnd.offset > sourceStartOffset
    )
  ) {
    throw new Error('Markdown selection crosses excluded content.');
  }
  const block = sourceMap.logicalLines.find(
    (line) => line.ref === startSegment.blockRef,
  );
  if (!block) throw new Error('Markdown selection block is missing.');

  const blockSegments = sourceMap.segments.filter(
    (segment) => segment.blockRef === block.ref,
  );
  const prefixLength = blockSegments
    .slice(0, startIndex - sourceMap.segments.indexOf(blockSegments[0]))
    .reduce((total, segment) => total + segment.text.length, 0) +
    selection.start.offset;
  const suffixStart = prefixLength + exact.length;
  const boundedContext = Math.max(0, Math.min(DEFAULT_CONTEXT_LENGTH, contextLength));

  return {
    kind: 'markdown-v1',
    start: sourcePointAt(markdown, sourceStartOffset),
    end: sourcePointAt(markdown, sourceEndOffset),
    exact,
    prefix: block.text.slice(Math.max(0, prefixLength - boundedContext), prefixLength),
    suffix: block.text.slice(suffixStart, suffixStart + boundedContext),
  };
}

function collectBlocks(
  nodes: readonly RootContent[],
  markdown: string,
  omitted: ReadonlySet<string>,
  state: MutableBuildState,
): void {
  for (const node of nodes) {
    if (node.type === 'html') {
      addExclusion(node, markdown, 'raw-html', state);
      continue;
    }
    if (node.type === 'code') {
      const language = normalizeLanguage(node.lang);
      if (omitted.has(language)) {
        addExclusion(node, markdown, 'omitted', state);
      } else if (language === 'mermaid') {
        addExclusion(node, markdown, 'generated', state);
      } else {
        addCodeSegments(node, markdown, state);
      }
      continue;
    }
    if (node.type === 'heading' || node.type === 'paragraph') {
      if (node.children.some((child) => child.type === 'html')) {
        addExclusion(node, markdown, 'raw-html', state);
        continue;
      }
      collectInlineBlock(node.children, markdown, state);
      continue;
    }
    if (node.type === 'table') {
      for (const row of node.children) {
        for (const cell of row.children) {
          collectInlineBlock(cell.children, markdown, state);
        }
      }
      continue;
    }
    if ('children' in node && Array.isArray(node.children)) {
      collectBlocks(node.children as RootContent[], markdown, omitted, state);
    }
  }
}

function collectInlineBlock(
  nodes: readonly PhrasingContent[],
  markdown: string,
  state: MutableBuildState,
): void {
  const blockRef = `m1-b${++state.blockCount}`;
  collectInline(nodes, blockRef, markdown, state);
}

function collectInline(
  nodes: readonly PhrasingContent[],
  blockRef: string,
  markdown: string,
  state: MutableBuildState,
): void {
  for (const node of nodes) {
    if (node.type === 'html') {
      addExclusion(node, markdown, 'raw-html', state);
      continue;
    }
    if (node.type === 'text') {
      addSegment(node, node.value, blockRef, markdown, state);
      continue;
    }
    if (node.type === 'inlineCode') {
      addSegment(node, node.value, blockRef, markdown, state);
      continue;
    }
    if (node.type === 'image') {
      addExclusion(node, markdown, 'generated', state);
      continue;
    }
    if ('children' in node && Array.isArray(node.children)) {
      collectInline(
        node.children as PhrasingContent[],
        blockRef,
        markdown,
        state,
      );
    }
  }
}

function addSegment(
  node: Text | InlineCode | Extract<PhrasingContent, { type: 'image' }>,
  text: string,
  blockRef: string,
  markdown: string,
  state: MutableBuildState,
): void {
  const range = nodeRange(node, markdown);
  if (!range || !text) return;
  const sourceText = markdown.slice(range.start.offset, range.end.offset);
  const segment: MarkdownSourceSegmentV1 = {
    ref: `m1-s${++state.segmentCount}`,
    blockRef,
    text,
    sourceStart: range.start,
    sourceEnd: range.end,
    mapping: sourceText === text ? 'identity' : 'atomic',
  };
  state.segments.push(segment);
  state.segmentByNode.set(node, segment);
  state.segmentsByNode.set(node, [segment]);
}

function addCodeSegments(
  node: Code,
  markdown: string,
  state: MutableBuildState,
): void {
  const range = nodeRange(node, markdown);
  if (!range || node.value === '') return;
  const source = markdown.slice(range.start.offset, range.end.offset);
  const openingEnd = source.indexOf('\n');
  const openingLine = openingEnd < 0 ? source : source.slice(0, openingEnd);
  if (openingEnd < 0 || !/^ {0,3}(?:`{3,}|~{3,})/.test(openingLine)) {
    addExclusion(node, markdown, 'generated', state);
    return;
  }
  const blockRef = `m1-b${++state.blockCount}`;
  const segments: MarkdownSourceSegmentV1[] = [];
  const renderedLines = node.value.replace(/\r\n?/g, '\n').split('\n');
  let sourceCursor = range.start.offset + openingEnd + 1;
  for (const [lineIndex, renderedLine] of renderedLines.entries()) {
    const lineFeed = markdown.indexOf('\n', sourceCursor);
    const rawEnd = lineFeed < 0 ? range.end.offset : lineFeed;
    const contentEnd = rawEnd > sourceCursor && markdown[rawEnd - 1] === '\r'
      ? rawEnd - 1
      : rawEnd;
    const lineSegment = addRangeSegment(
      node,
      renderedLine,
      blockRef,
      markdown,
      sourceCursor,
      contentEnd,
      state,
    );
    if (lineSegment) segments.push(lineSegment);
    if (lineIndex < renderedLines.length - 1) {
      const newlineEnd = lineFeed < 0 ? contentEnd : lineFeed + 1;
      const newline = addRangeSegment(
        node,
        '\n',
        blockRef,
        markdown,
        contentEnd,
        newlineEnd,
        state,
      );
      if (newline) segments.push(newline);
      sourceCursor = newlineEnd;
    }
  }
  if (segments.length > 0) {
    state.segmentByNode.set(node, segments[0]);
    state.segmentsByNode.set(node, segments);
  }
}

function addRangeSegment(
  node: object,
  text: string,
  blockRef: string,
  markdown: string,
  start: number,
  end: number,
  state: MutableBuildState,
): MarkdownSourceSegmentV1 | undefined {
  if (text === '' || start < 0 || end < start || end > markdown.length) return undefined;
  const segment: MarkdownSourceSegmentV1 = {
    ref: `m1-s${++state.segmentCount}`,
    blockRef,
    text,
    sourceStart: sourcePointAt(markdown, start),
    sourceEnd: sourcePointAt(markdown, end),
    mapping: markdown.slice(start, end) === text ? 'identity' : 'atomic',
  };
  state.segments.push(segment);
  const existing = state.segmentsByNode.get(node) ?? [];
  state.segmentsByNode.set(node, [...existing, segment]);
  return segment;
}

function addExclusion(
  node: Code | Html | PositionedNode,
  markdown: string,
  reason: MarkdownSourceExclusionV1['reason'],
  state: MutableBuildState,
): void {
  const range = nodeRange(node, markdown);
  if (!range) return;
  state.exclusions.push({
    sourceStart: range.start,
    sourceEnd: range.end,
    reason,
  });
}

function nodeRange(
  node: PositionedNode,
  markdown: string,
): { start: MarkdownSourcePointV1; end: MarkdownSourcePointV1 } | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start === undefined ||
    end === undefined ||
    start < 0 ||
    end < start ||
    end > markdown.length
  ) {
    return null;
  }
  return {
    start: sourcePointAt(markdown, start),
    end: sourcePointAt(markdown, end),
  };
}

function buildLogicalLines(
  segments: readonly MarkdownSourceSegmentV1[],
): MarkdownLogicalLineV1[] {
  const lines: MarkdownLogicalLineV1[] = [];
  for (const segment of segments) {
    const current = lines.at(-1);
    if (current?.ref === segment.blockRef) {
      current.text += segment.text;
      current.segmentRefs.push(segment.ref);
      current.sourceEnd = segment.sourceEnd;
      continue;
    }
    lines.push({
      ref: segment.blockRef,
      text: segment.text,
      segmentRefs: [segment.ref],
      sourceStart: segment.sourceStart,
      sourceEnd: segment.sourceEnd,
    });
  }
  return lines;
}

function validateBoundary(
  segment: MarkdownSourceSegmentV1,
  offset: number,
  label: string,
): void {
  if (!Number.isInteger(offset) || offset < 0 || offset > segment.text.length) {
    throw new Error(`Markdown ${label} boundary is outside its mapped segment.`);
  }
  if (
    segment.mapping === 'atomic' &&
    offset !== 0 &&
    offset !== segment.text.length
  ) {
    throw new Error(`Markdown ${label} boundary splits an atomic mapped segment.`);
  }
}

function resolveSourceBoundary(
  segment: MarkdownSourceSegmentV1,
  offset: number,
): number {
  if (segment.mapping === 'identity') return segment.sourceStart.offset + offset;
  return offset === 0 ? segment.sourceStart.offset : segment.sourceEnd.offset;
}

function sourcePointAt(markdown: string, offset: number): MarkdownSourcePointV1 {
  if (!Number.isInteger(offset) || offset < 0 || offset > markdown.length) {
    throw new Error('Markdown source offset is outside the source.');
  }
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    if (markdown.charCodeAt(index) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { offset, line, column };
}

function positionedText(
  value: string,
  markdown: string,
  start: number,
  end: number,
): Text {
  return {
    type: 'text',
    value,
    position: {
      start: sourcePointAt(markdown, start),
      end: sourcePointAt(markdown, end),
    },
  };
}

function normalizeLanguage(language: string | null | undefined): string {
  return language?.trim().toLowerCase() ?? '';
}
