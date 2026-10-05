import assert from 'node:assert/strict';
import test from 'node:test';

import {
  renderMarkdownWithSourceMap,
  resolveMarkdownSelection,
} from 'mdmaid';
import { renderMarkdownToTuiWithSourceMap } from 'mdmaid/tui';

function segmentFor(map, text, occurrence = 0) {
  const matches = map.segments.filter((segment) => segment.text === text);
  assert.ok(matches[occurrence], `missing mapped segment ${JSON.stringify(text)}`);
  return matches[occurrence];
}

test('Web positioned rendering maps duplicate formatted text to exact original UTF-16 offsets', async () => {
  const markdown = 'Before **same** and [same](https://example.com) after.';
  const result = await renderMarkdownWithSourceMap(markdown);

  assert.equal(result.sourceMap.version, 1);
  assert.equal(result.sourceMap.coordinateSystem, 'utf16-code-units');
  assert.equal(result.sourceMap.sourceLength, markdown.length);
  assert.match(result.html, /data-mdmaid-source-ref="m1-s\d+"/);

  const first = segmentFor(result.sourceMap, 'same', 0);
  const second = segmentFor(result.sourceMap, 'same', 1);
  assert.deepEqual(
    [first.sourceStart.offset, first.sourceEnd.offset],
    [markdown.indexOf('same'), markdown.indexOf('same') + 4],
  );
  assert.deepEqual(
    [second.sourceStart.offset, second.sourceEnd.offset],
    [markdown.lastIndexOf('same'), markdown.lastIndexOf('same') + 4],
  );
  assert.notEqual(first.ref, second.ref);
  assert.equal(first.blockRef, second.blockRef);
});

test('selection resolution crosses inline Markdown syntax but not block gaps', async () => {
  const markdown = 'A **bold** and [linked](https://example.com) phrase.\n\nNext block.';
  const result = await renderMarkdownWithSourceMap(markdown);
  const bold = segmentFor(result.sourceMap, 'bold');
  const linked = segmentFor(result.sourceMap, 'linked');
  const next = segmentFor(result.sourceMap, 'Next block.');

  const anchor = resolveMarkdownSelection(markdown, result.sourceMap, {
    start: { ref: bold.ref, offset: 1 },
    end: { ref: linked.ref, offset: 4 },
  });

  assert.equal(anchor.kind, 'markdown-v1');
  assert.equal(anchor.exact, 'old and link');
  assert.equal(anchor.start.offset, markdown.indexOf('bold') + 1);
  assert.equal(anchor.end.offset, markdown.indexOf('linked') + 4);
  assert.equal(anchor.start.line, 1);
  assert.equal(anchor.start.column, markdown.indexOf('bold') + 2);
  assert.ok(anchor.prefix.length <= 128);
  assert.ok(anchor.suffix.length <= 128);

  assert.throws(
    () =>
      resolveMarkdownSelection(markdown, result.sourceMap, {
        start: { ref: bold.ref, offset: 0 },
        end: { ref: next.ref, offset: 4 },
      }),
    /same selectable block/i,
  );
});

test('positions preserve CRLF and non-BMP UTF-16 coordinates without Unicode normalization', async () => {
  const markdown = 'Title\r\n\r\nEmoji 😀 café e\u0301.';
  const result = await renderMarkdownWithSourceMap(markdown);
  const text = segmentFor(result.sourceMap, 'Emoji 😀 café e\u0301.');
  const emojiOffset = markdown.indexOf('😀');

  assert.equal(text.sourceStart.offset, markdown.indexOf('Emoji'));
  assert.equal(text.sourceStart.line, 3);
  assert.equal(text.sourceStart.column, 1);

  const anchor = resolveMarkdownSelection(markdown, result.sourceMap, {
    start: { ref: text.ref, offset: emojiOffset - text.sourceStart.offset },
    end: { ref: text.ref, offset: emojiOffset - text.sourceStart.offset + 2 },
  });
  assert.equal(anchor.exact, '😀');
  assert.equal(anchor.start.offset, emojiOffset);
  assert.equal(anchor.end.offset, emojiOffset + 2);
  assert.equal(anchor.end.column, anchor.start.column + 2);
});

test('omitted diff fences retain original positions and cannot bridge a removed gap', async () => {
  const markdown = [
    'Before text.',
    '',
    '```diff',
    '-old',
    '+new',
    '```',
    '',
    'After text.',
  ].join('\n');
  const result = await renderMarkdownWithSourceMap(markdown, {
    omitFencedCodeLanguages: ['diff'],
  });
  const before = segmentFor(result.sourceMap, 'Before text.');
  const after = segmentFor(result.sourceMap, 'After text.');

  assert.doesNotMatch(result.html, /old|new/);
  assert.equal(after.sourceStart.offset, markdown.indexOf('After text.'));
  assert.throws(
    () =>
      resolveMarkdownSelection(markdown, result.sourceMap, {
        start: { ref: before.ref, offset: 0 },
        end: { ref: after.ref, offset: 5 },
      }),
    /same selectable block/i,
  );
});

test('atomic transformed segments accept only whole-segment boundaries', async () => {
  const markdown = 'Status :rocket: ready.';
  const result = await renderMarkdownWithSourceMap(markdown);
  const rocket = segmentFor(result.sourceMap, '🚀');

  assert.equal(rocket.mapping, 'atomic');
  const anchor = resolveMarkdownSelection(markdown, result.sourceMap, {
    start: { ref: rocket.ref, offset: 0 },
    end: { ref: rocket.ref, offset: rocket.text.length },
  });
  assert.equal(anchor.exact, '🚀');
  assert.equal(
    markdown.slice(anchor.start.offset, anchor.end.offset),
    ':rocket:',
  );
  assert.throws(
    () =>
      resolveMarkdownSelection(markdown, result.sourceMap, {
        start: { ref: rocket.ref, offset: 1 },
        end: { ref: rocket.ref, offset: rocket.text.length },
      }),
    /atomic/i,
  );
});

test('transformed emoji retain exact source ranges after escaped and decoded text', async () => {
  for (const markdown of [
    'Escaped \\*literal\\* :rocket: ready.',
    'Entity &amp; then :rocket: ready.',
  ]) {
    const result = await renderMarkdownWithSourceMap(markdown);
    const rocket = segmentFor(result.sourceMap, '🚀');
    const anchor = resolveMarkdownSelection(markdown, result.sourceMap, {
      start: { ref: rocket.ref, offset: 0 },
      end: { ref: rocket.ref, offset: rocket.text.length },
    });

    assert.equal(anchor.exact, '🚀');
    assert.equal(markdown.slice(anchor.start.offset, anchor.end.offset), ':rocket:');
  }
});

test('selection resolution rejects excluded content inside one inline block', async () => {
  const markdown = 'before ![alt](image.png) after';
  const result = await renderMarkdownWithSourceMap(markdown);
  const before = segmentFor(result.sourceMap, 'before ');
  const after = segmentFor(result.sourceMap, ' after');

  assert.throws(
    () => resolveMarkdownSelection(markdown, result.sourceMap, {
      start: { ref: before.ref, offset: 0 },
      end: { ref: after.ref, offset: after.text.length },
    }),
    /excluded content/i,
  );
});

test('positioned rendering reserves source-ref attributes from raw Markdown HTML', async () => {
  const markdown = [
    '<span data-mdmaid-source-ref="m1-s1">forged</span>',
    '',
    'legitimate',
  ].join('\n');
  const result = await renderMarkdownWithSourceMap(markdown, { sanitize: false });

  assert.doesNotMatch(result.html, /data-mdmaid-source-ref="m1-s1">forged/);
  assert.match(result.html, /<span[^>]*>forged<\/span>/);
  assert.match(result.html, /data-mdmaid-source-ref="m1-s1">legitimate/);
});

test('positioned rendering preserves inline-code semantics', async () => {
  const markdown = 'Use `code` here.';
  const result = await renderMarkdownWithSourceMap(markdown);
  const code = segmentFor(result.sourceMap, 'code');

  assert.match(
    result.html,
    new RegExp(`<code><span data-mdmaid-source-ref="${code.ref}">code<\\/span><\\/code>`),
  );
  const anchor = resolveMarkdownSelection(markdown, result.sourceMap, {
    start: { ref: code.ref, offset: 0 },
    end: { ref: code.ref, offset: code.text.length },
  });
  assert.equal(markdown.slice(anchor.start.offset, anchor.end.offset), '`code`');
});

test('ordinary fenced code is selectable while Mermaid remains excluded', async () => {
  const markdown = [
    '```ts',
    'const value = 1;',
    'return value;',
    '```',
  ].join('\n');
  const result = await renderMarkdownWithSourceMap(markdown);
  const first = segmentFor(result.sourceMap, 'const value = 1;');
  const second = segmentFor(result.sourceMap, 'return value;');

  assert.match(result.html, new RegExp(`data-mdmaid-source-ref="${first.ref}"`));
  const anchor = resolveMarkdownSelection(markdown, result.sourceMap, {
    start: { ref: first.ref, offset: 6 },
    end: { ref: second.ref, offset: 6 },
  });
  assert.equal(anchor.exact, 'value = 1;\nreturn');
  assert.equal(
    markdown.slice(anchor.start.offset, anchor.end.offset),
    'value = 1;\nreturn',
  );
});

test('fenced code preserves CRLF source positions across rendered lines', async () => {
  const markdown = '```ts\r\nfirst();\r\nsecond();\r\n```';
  const result = await renderMarkdownWithSourceMap(markdown);
  const first = segmentFor(result.sourceMap, 'first();');
  const second = segmentFor(result.sourceMap, 'second();');
  const anchor = resolveMarkdownSelection(markdown, result.sourceMap, {
    start: { ref: first.ref, offset: 0 },
    end: { ref: second.ref, offset: second.text.length },
  });

  assert.equal(anchor.exact, 'first();\nsecond();');
  assert.equal(
    markdown.slice(anchor.start.offset, anchor.end.offset),
    'first();\r\nsecond();',
  );
});

test('TUI positioned rendering exposes width-independent logical source lines', async () => {
  const markdown = [
    '# Heading',
    '',
    'A **formatted** paragraph that wraps over a narrow terminal width.',
    '',
    '- first item',
    '- second item',
  ].join('\n');

  const narrow = await renderMarkdownToTuiWithSourceMap(markdown, {
    backend: 'beautiful-mermaid',
    color: false,
    width: 24,
  });
  const wide = await renderMarkdownToTuiWithSourceMap(markdown, {
    backend: 'beautiful-mermaid',
    color: false,
    width: 100,
  });

  assert.notEqual(narrow.output, wide.output);
  assert.deepEqual(narrow.sourceMap, wide.sourceMap);
  assert.equal(narrow.sourceMap.version, 1);
  assert.ok(
    narrow.sourceMap.logicalLines.some((line) =>
      line.text.includes('formatted paragraph'),
    ),
  );
  const formatted = segmentFor(narrow.sourceMap, 'formatted');
  assert.deepEqual(
    [formatted.sourceStart.offset, formatted.sourceEnd.offset],
    [markdown.indexOf('formatted'), markdown.indexOf('formatted') + 9],
  );
});

test('TUI positioned rendering and source map share emoji text', async () => {
  const markdown = 'Status :rocket: ready.';
  const result = await renderMarkdownToTuiWithSourceMap(markdown, {
    backend: 'beautiful-mermaid',
    color: false,
    width: 80,
  });

  assert.match(result.output, /Status 🚀 ready\./);
  assert.equal(result.sourceMap.logicalLines[0]?.text, 'Status 🚀 ready.');
});

test('generated Mermaid and raw HTML are explicitly non-selectable', async () => {
  const markdown = [
    '<span>raw</span>',
    '',
    '```mermaid',
    'graph LR',
    '  A --> B',
    '```',
  ].join('\n');
  const web = await renderMarkdownWithSourceMap(markdown);
  const tui = await renderMarkdownToTuiWithSourceMap(markdown, {
    backend: 'beautiful-mermaid',
    width: 80,
  });

  assert.equal(web.sourceMap.segments.length, 0);
  assert.equal(tui.sourceMap.segments.length, 0);
  assert.ok(web.sourceMap.exclusions.some((item) => item.reason === 'raw-html'));
  assert.ok(web.sourceMap.exclusions.some((item) => item.reason === 'generated'));
});
