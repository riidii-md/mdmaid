/**
 * mdmaid - Markdown + Mermaid made simple
 *
 * A powerful markdown renderer with first-class Mermaid diagram support
 */

export {
  renderMarkdown,
  renderMarkdownWithSourceMap,
  extractMermaidBlocks,
  type PositionedMarkdownRenderResult,
  type RenderOptions,
} from '../core/renderer.js';
export {
  MARKDOWN_SOURCE_COORDINATE_SYSTEM,
  MARKDOWN_SOURCE_MAP_VERSION,
  createMarkdownSourceMap,
  resolveMarkdownSelection,
  type MarkdownLogicalLineV1,
  type MarkdownSelectionBoundaryV1,
  type MarkdownSelectionWitnessV1,
  type MarkdownSourceExclusionV1,
  type MarkdownSourceMapOptions,
  type MarkdownSourceMapV1,
  type MarkdownSourcePointV1,
  type MarkdownSourceSegmentV1,
  type MarkdownTextAnchorV1,
} from '../core/source-map.js';
export {
  validateMarkdown,
  validateMermaid,
  type MarkdownValidationResult,
  type MermaidValidationResult,
  type ValidateMarkdownOptions,
  type ValidationDiagnostic,
  type ValidationKind,
  type ValidationLocation,
  type ValidationMode,
  type ValidationPoint,
  type ValidationSeverity,
  type ValidationStage,
} from '../core/validation.js';

// Re-export for convenience
export { remark } from 'remark';
