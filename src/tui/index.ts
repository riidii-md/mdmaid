import { renderWithBeautifulMermaid } from './backends/beautiful-mermaid.js';
import {
  renderMarkdownSource,
  renderMermaidSource,
} from './backends/source.js';
import { renderWithVeol } from './backends/veol.js';
import { renderMarkdownMermaidFallback } from './markdown.js';
import { sanitizeTerminalText } from './security.js';
import { createMarkdownSourceMap, type MarkdownSourceMapV1 } from '../core/source-map.js';
import type { TuiRenderOptions, TuiRenderResult } from './types.js';

export type { TuiBackend, TuiRenderOptions, TuiRenderResult } from './types.js';

export interface PositionedTuiRenderResult extends TuiRenderResult {
  sourceMap: MarkdownSourceMapV1;
}

export async function renderMarkdownToTuiWithSourceMap(
  markdown: string,
  options: TuiRenderOptions = {},
): Promise<PositionedTuiRenderResult> {
  if (options.backend === 'veol' || options.backend === 'source') {
    throw new Error(
      `The ${options.backend} TUI backend does not support Markdown source maps.`,
    );
  }
  const positionedOptions: TuiRenderOptions = {
    ...options,
    backend: 'beautiful-mermaid',
  };
  const [result, sourceMap] = await Promise.all([
    renderMarkdownToTui(markdown, positionedOptions),
    createMarkdownSourceMap(markdown, options),
  ]);
  return { ...result, sourceMap };
}

export async function renderMarkdownToTui(
  markdown: string,
  options: TuiRenderOptions = {},
): Promise<TuiRenderResult> {
  const backend = options.backend ?? 'auto';
  const warnings: string[] = [];
  const safeMarkdown = sanitizeTerminalText(markdown);

  if (backend === 'auto' || backend === 'veol') {
    const result = await renderWithVeol(safeMarkdown, options);

    if (result.output !== undefined) {
      return {
        output: sanitizeTerminalText(result.output),
        backend: 'veol',
        warnings,
      };
    }

    if (result.warning) warnings.push(sanitizeTerminalText(result.warning));
    if (backend === 'veol') return renderMarkdownSource(safeMarkdown, warnings);
  }

  if (
    backend === 'beautiful-mermaid' ||
    (backend === 'auto' && options.beautifulMermaid !== false)
  ) {
    const result = await renderMarkdownMermaidFallback(
      safeMarkdown,
      (code) => renderMermaidWithBeautifulFallback(code, options),
      options,
    );

    return {
      ...result,
      warnings: [...warnings, ...result.warnings],
    };
  }

  return renderMarkdownSource(safeMarkdown, warnings);
}

export async function renderMermaidToAscii(
  code: string,
  options: TuiRenderOptions = {},
): Promise<TuiRenderResult> {
  const backend = options.backend ?? 'auto';
  const warnings: string[] = [];
  const safeCode = sanitizeTerminalText(code);

  if (backend === 'auto' || backend === 'veol') {
    const source = renderMermaidSource(safeCode).output;
    const result = await renderWithVeol(`${source}\n`, options);

    if (result.output !== undefined) {
      return {
        output: sanitizeTerminalText(result.output),
        backend: 'veol',
        warnings,
      };
    }

    if (result.warning) warnings.push(sanitizeTerminalText(result.warning));
    if (backend === 'veol') return renderMermaidSource(safeCode, warnings);
  }

  if (
    backend === 'beautiful-mermaid' ||
    (backend === 'auto' && options.beautifulMermaid !== false)
  ) {
    const result = await renderMermaidWithBeautifulFallback(safeCode, options);

    if (result.backend === 'beautiful-mermaid') {
      return {
        ...result,
        warnings: [...warnings, ...result.warnings],
      };
    }

    warnings.push(...result.warnings);
  }

  return renderMermaidSource(safeCode, warnings);
}

async function renderMermaidWithBeautifulFallback(
  code: string,
  options: TuiRenderOptions,
): Promise<TuiRenderResult> {
  const result = await renderWithBeautifulMermaid(code, options);

  if (result.output !== undefined) {
    return {
      output: sanitizeTerminalText(result.output),
      backend: 'beautiful-mermaid',
      warnings: [],
    };
  }

  return renderMermaidSource(
    code,
    result.warning ? [sanitizeTerminalText(result.warning)] : [],
  );
}
