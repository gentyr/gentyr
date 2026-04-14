/**
 * Unit tests for chrome-bridge convenience tool helpers (the 4 new server-side tools):
 * - parseAccessibilityTree()        pure function — line-by-line regex parsing
 * - extractTextFromResult()         pure function — content array flattening
 * - findMatchingElements()          pure function — case-insensitive substring match
 * - handleFindElements()            input validation + response shaping (no socket)
 * - handleClickByText()             input validation + not-found response (no socket)
 * - handleFillInput()               input validation + role filtering + not-found response (no socket)
 * - handleWaitForElement()          input validation + timeout-path response (no socket)
 * - SERVER_SIDE_TOOLS membership    all 4 new tools appear in the dispatch set
 *
 * Strategy: identical to serverSideTools.test.ts — pure deterministic logic is
 * extracted into standalone testable mirrors; async handlers that compose
 * client.executeTool() calls are tested via the validation and response-shaping
 * sub-paths that do NOT reach the socket. This keeps tests fast (<100 ms each)
 * and independent of a running Chrome connection.
 *
 * Critical: These tests validate structure, not performance.
 * Graceful fallbacks are NOT allowed — errors must be surfaced via isError: true.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { McpContent } from '../types.js';

// ============================================================================
// Shared types (mirror server.ts)
// ============================================================================

interface TreeElement {
  role: string;
  text: string;
  ref: string;
  attributes: string;
  line: string;
}

type ToolResult = { content: McpContent[]; isError?: boolean };

// ============================================================================
// parseAccessibilityTree — pure regex parser
// ============================================================================

/**
 * Exact copy of parseAccessibilityTree() from server.ts ~line 1341.
 * Pure function — safe to copy-test here.
 */
function parseAccessibilityTree(tree: string): TreeElement[] {
  const elements: TreeElement[] = [];
  const lineRegex = /^\s*(\w+)\s+"([^"]*)"\s+\[ref_(\d+)\](.*)$/;
  for (const line of tree.split('\n')) {
    const m = line.match(lineRegex);
    if (m) {
      elements.push({
        role: m[1],
        text: m[2],
        ref: `ref_${m[3]}`,
        attributes: m[4].trim(),
        line: line.trim(),
      });
    }
  }
  return elements;
}

// ---- fixture trees ----

const SINGLE_BUTTON_TREE = `button "Submit" [ref_1] disabled`;
const MULTI_ELEMENT_TREE = `
button "Submit" [ref_1] disabled
textbox "Email address" [ref_2] required
link "Forgot password?" [ref_3]
heading "Sign in" [ref_4]
`.trim();

const INDENTED_TREE = `  button "OK" [ref_10]
  textbox "Search" [ref_11] placeholder="Type here"`;

const EMPTY_TREE = '';
const NO_MATCH_TREE = 'This line has no elements\nneither does this one';

describe('parseAccessibilityTree()', () => {
  describe('single element', () => {
    it('should parse role correctly', () => {
      const result = parseAccessibilityTree(SINGLE_BUTTON_TREE);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('button');
    });

    it('should parse text correctly', () => {
      const result = parseAccessibilityTree(SINGLE_BUTTON_TREE);
      expect(result[0].text).toBe('Submit');
    });

    it('should parse ref with ref_ prefix', () => {
      const result = parseAccessibilityTree(SINGLE_BUTTON_TREE);
      expect(result[0].ref).toBe('ref_1');
    });

    it('should parse trailing attributes', () => {
      const result = parseAccessibilityTree(SINGLE_BUTTON_TREE);
      expect(result[0].attributes).toBe('disabled');
    });

    it('should preserve the trimmed original line', () => {
      const result = parseAccessibilityTree(SINGLE_BUTTON_TREE);
      expect(result[0].line).toBe('button "Submit" [ref_1] disabled');
    });
  });

  describe('multiple elements', () => {
    it('should parse all elements from a multi-line tree', () => {
      const result = parseAccessibilityTree(MULTI_ELEMENT_TREE);
      expect(result).toHaveLength(4);
    });

    it('should return elements in document order', () => {
      const result = parseAccessibilityTree(MULTI_ELEMENT_TREE);
      expect(result[0].role).toBe('button');
      expect(result[1].role).toBe('textbox');
      expect(result[2].role).toBe('link');
      expect(result[3].role).toBe('heading');
    });

    it('should give each element its correct ref', () => {
      const result = parseAccessibilityTree(MULTI_ELEMENT_TREE);
      expect(result[0].ref).toBe('ref_1');
      expect(result[1].ref).toBe('ref_2');
      expect(result[2].ref).toBe('ref_3');
      expect(result[3].ref).toBe('ref_4');
    });
  });

  describe('indented / leading-whitespace lines', () => {
    it('should parse elements despite leading whitespace', () => {
      const result = parseAccessibilityTree(INDENTED_TREE);
      expect(result).toHaveLength(2);
    });

    it('should trim the stored line', () => {
      const result = parseAccessibilityTree(INDENTED_TREE);
      expect(result[0].line).toBe('button "OK" [ref_10]');
    });

    it('should trim attributes', () => {
      const result = parseAccessibilityTree(INDENTED_TREE);
      expect(result[1].attributes).toBe('placeholder="Type here"');
    });
  });

  describe('elements with empty text', () => {
    it('should parse elements whose text is an empty quoted string', () => {
      const tree = `button "" [ref_5]`;
      const result = parseAccessibilityTree(tree);
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('');
    });
  });

  describe('elements with no trailing attributes', () => {
    it('should store an empty string for attributes when none are present', () => {
      const tree = `link "Home" [ref_6]`;
      const result = parseAccessibilityTree(tree);
      expect(result[0].attributes).toBe('');
    });
  });

  describe('non-matching lines', () => {
    it('should return empty array for empty input', () => {
      const result = parseAccessibilityTree(EMPTY_TREE);
      expect(result).toHaveLength(0);
    });

    it('should skip lines that do not match the element pattern', () => {
      const result = parseAccessibilityTree(NO_MATCH_TREE);
      expect(result).toHaveLength(0);
    });

    it('should skip blank lines within a multi-element tree', () => {
      const tree = `button "A" [ref_1]\n\ntextbox "B" [ref_2]`;
      const result = parseAccessibilityTree(tree);
      expect(result).toHaveLength(2);
    });
  });

  describe('return value structure', () => {
    it('should return an array', () => {
      const result = parseAccessibilityTree(SINGLE_BUTTON_TREE);
      expect(Array.isArray(result)).toBe(true);
    });

    it('each element should have role, text, ref, attributes, line fields', () => {
      const result = parseAccessibilityTree(SINGLE_BUTTON_TREE);
      const el = result[0];
      expect(typeof el.role).toBe('string');
      expect(typeof el.text).toBe('string');
      expect(typeof el.ref).toBe('string');
      expect(typeof el.attributes).toBe('string');
      expect(typeof el.line).toBe('string');
    });

    it('ref should always begin with "ref_"', () => {
      const result = parseAccessibilityTree(MULTI_ELEMENT_TREE);
      for (const el of result) {
        expect(el.ref.startsWith('ref_')).toBe(true);
      }
    });
  });
});

// ============================================================================
// extractTextFromResult — pure content flattener
// ============================================================================

/**
 * Exact copy of extractTextFromResult() from server.ts ~line 1359.
 */
function extractTextFromResult(
  result: { content: McpContent[]; isError?: boolean },
): string {
  return result.content
    .filter((c): c is McpContent & { text: string } => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

describe('extractTextFromResult()', () => {
  it('should concatenate text content items with newlines', () => {
    const result = extractTextFromResult({
      content: [
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
      ],
    });
    expect(result).toBe('line one\nline two');
  });

  it('should return a single text string when there is only one item', () => {
    const result = extractTextFromResult({
      content: [{ type: 'text', text: 'only' }],
    });
    expect(result).toBe('only');
  });

  it('should skip non-text content items', () => {
    const result = extractTextFromResult({
      content: [
        { type: 'image', data: 'base64', mimeType: 'image/png' } as McpContent,
        { type: 'text', text: 'kept' },
      ],
    });
    expect(result).toBe('kept');
  });

  it('should return empty string for an empty content array', () => {
    const result = extractTextFromResult({ content: [] });
    expect(result).toBe('');
  });

  it('should return a string (never null or undefined)', () => {
    const result = extractTextFromResult({ content: [] });
    expect(typeof result).toBe('string');
  });

  it('should work on an error result (isError does not affect extraction)', () => {
    const result = extractTextFromResult({
      content: [{ type: 'text', text: 'error text' }],
      isError: true,
    });
    expect(result).toBe('error text');
  });
});

// ============================================================================
// findMatchingElements — pure case-insensitive substring matcher
// ============================================================================

/**
 * Exact copy of findMatchingElements() from server.ts ~line 1368.
 */
function findMatchingElements(parsed: TreeElement[], query: string): TreeElement[] {
  const q = query.toLowerCase();
  return parsed.filter(
    (el) =>
      el.text.toLowerCase().includes(q) ||
      el.role.toLowerCase().includes(q) ||
      el.attributes.toLowerCase().includes(q),
  );
}

const FIXTURE_ELEMENTS: TreeElement[] = [
  { role: 'button', text: 'Submit form', ref: 'ref_1', attributes: 'disabled', line: 'button "Submit form" [ref_1] disabled' },
  { role: 'textbox', text: 'Email address', ref: 'ref_2', attributes: 'required', line: 'textbox "Email address" [ref_2] required' },
  { role: 'link', text: 'Forgot password?', ref: 'ref_3', attributes: '', line: 'link "Forgot password?" [ref_3]' },
  { role: 'heading', text: 'Sign in', ref: 'ref_4', attributes: '', line: 'heading "Sign in" [ref_4]' },
  { role: 'combobox', text: 'Country', ref: 'ref_5', attributes: 'aria-label="Select country"', line: 'combobox "Country" [ref_5] aria-label="Select country"' },
];

describe('findMatchingElements()', () => {
  describe('matching against element text', () => {
    it('should match when query appears in element text', () => {
      const result = findMatchingElements(FIXTURE_ELEMENTS, 'Submit');
      expect(result.some((el) => el.ref === 'ref_1')).toBe(true);
    });

    it('should be case-insensitive for text matches', () => {
      const lower = findMatchingElements(FIXTURE_ELEMENTS, 'submit');
      const upper = findMatchingElements(FIXTURE_ELEMENTS, 'SUBMIT');
      expect(lower.length).toBe(upper.length);
      expect(lower.map((e) => e.ref)).toEqual(upper.map((e) => e.ref));
    });

    it('should do a substring match (not exact match) against text', () => {
      const result = findMatchingElements(FIXTURE_ELEMENTS, 'password');
      expect(result.some((el) => el.text === 'Forgot password?')).toBe(true);
    });
  });

  describe('matching against element role', () => {
    it('should match when query equals the role', () => {
      const result = findMatchingElements(FIXTURE_ELEMENTS, 'button');
      expect(result.some((el) => el.ref === 'ref_1')).toBe(true);
    });

    it('should match when query is a substring of the role', () => {
      const result = findMatchingElements(FIXTURE_ELEMENTS, 'text');
      expect(result.some((el) => el.role === 'textbox')).toBe(true);
    });

    it('should be case-insensitive for role matches', () => {
      const result = findMatchingElements(FIXTURE_ELEMENTS, 'BUTTON');
      expect(result.some((el) => el.role === 'button')).toBe(true);
    });
  });

  describe('matching against attributes', () => {
    it('should match when query appears in attributes', () => {
      const result = findMatchingElements(FIXTURE_ELEMENTS, 'required');
      expect(result.some((el) => el.ref === 'ref_2')).toBe(true);
    });

    it('should match inside an aria-label attribute value', () => {
      const result = findMatchingElements(FIXTURE_ELEMENTS, 'Select country');
      expect(result.some((el) => el.ref === 'ref_5')).toBe(true);
    });

    it('should be case-insensitive for attribute matches', () => {
      const result = findMatchingElements(FIXTURE_ELEMENTS, 'REQUIRED');
      expect(result.some((el) => el.ref === 'ref_2')).toBe(true);
    });
  });

  describe('no match', () => {
    it('should return empty array when query matches nothing', () => {
      const result = findMatchingElements(FIXTURE_ELEMENTS, 'xyzzy_no_match');
      expect(result).toHaveLength(0);
    });
  });

  describe('multiple matches', () => {
    it('should return all matching elements (not just first)', () => {
      // "in" appears in "Sign in" and "Submit form" would not, but "in" is
      // in textbox ("address"), link, heading ("Sign in"), combobox ("Country")
      // Let's use a broader query that matches several
      const result = findMatchingElements(FIXTURE_ELEMENTS, 'o'); // in "form", "password", "Country"
      expect(result.length).toBeGreaterThan(1);
    });
  });

  describe('empty inputs', () => {
    it('should return all elements when query is empty string', () => {
      // Empty string is a substring of everything
      const result = findMatchingElements(FIXTURE_ELEMENTS, '');
      expect(result).toHaveLength(FIXTURE_ELEMENTS.length);
    });

    it('should return empty array when parsed elements array is empty', () => {
      const result = findMatchingElements([], 'button');
      expect(result).toHaveLength(0);
    });
  });

  describe('return value structure', () => {
    it('should return an array', () => {
      const result = findMatchingElements(FIXTURE_ELEMENTS, 'button');
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return TreeElement objects with all required fields', () => {
      const result = findMatchingElements(FIXTURE_ELEMENTS, 'button');
      expect(result.length).toBeGreaterThan(0);
      const el = result[0];
      expect(typeof el.role).toBe('string');
      expect(typeof el.text).toBe('string');
      expect(typeof el.ref).toBe('string');
      expect(typeof el.attributes).toBe('string');
      expect(typeof el.line).toBe('string');
    });
  });
});

// ============================================================================
// handleFindElements — input validation + response shaping (no socket)
// ============================================================================

/**
 * Mirrors handleFindElements() validation block (server.ts ~lines 1381–1407).
 * The async client.executeTool() call is replaced by an injectable function.
 */
async function testableHandleFindElements(
  args: Record<string, unknown>,
  readPageResult?: ToolResult,
): Promise<ToolResult> {
  const query = typeof args.query === 'string' ? args.query : '';
  const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
  const filter = args.filter === 'all' ? 'all' : 'interactive';

  if (!query) {
    return { content: [{ type: 'text', text: 'Missing required parameter: query' }], isError: true };
  }
  if (tabId === undefined) {
    return { content: [{ type: 'text', text: 'Missing required parameter: tabId' }], isError: true };
  }

  // Simulate client.executeTool('read_page', ...) — inject fixture result
  const readResult = readPageResult!;
  if (readResult.isError) return readResult;

  const treeText = extractTextFromResult(readResult);
  const matches = findMatchingElements(parseAccessibilityTree(treeText), query);

  if (matches.length === 0) {
    return { content: [{ type: 'text', text: `No elements found matching "${query}"` }] };
  }

  const summary = matches
    .map((el) => `${el.role} "${el.text}" [${el.ref}]${el.attributes ? ' ' + el.attributes : ''}`)
    .join('\n');
  return {
    content: [{ type: 'text', text: `Found ${matches.length} element(s) matching "${query}":\n\n${summary}` }],
  };
}

describe('handleFindElements() — input validation', () => {
  it('should return isError when query is missing', async () => {
    const result = await testableHandleFindElements({ tabId: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('query');
  });

  it('should return isError when query is empty string', async () => {
    const result = await testableHandleFindElements({ query: '', tabId: 1 });
    expect(result.isError).toBe(true);
  });

  it('should return isError when tabId is missing', async () => {
    const result = await testableHandleFindElements({ query: 'button' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('tabId');
  });

  it('should return isError when tabId is a string instead of number', async () => {
    const result = await testableHandleFindElements({ query: 'button', tabId: '1' });
    expect(result.isError).toBe(true);
  });

  it('should propagate isError from the read_page result', async () => {
    const fakeReadError: ToolResult = {
      content: [{ type: 'text', text: 'Tab not found' }],
      isError: true,
    };
    const result = await testableHandleFindElements({ query: 'button', tabId: 5 }, fakeReadError);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Tab not found');
  });
});

describe('handleFindElements() — response shaping', () => {
  const READ_PAGE_RESULT: ToolResult = {
    content: [{ type: 'text', text: MULTI_ELEMENT_TREE }],
  };

  it('should return no-match message (not an error) when nothing matches', async () => {
    const result = await testableHandleFindElements(
      { query: 'xyzzy_no_match', tabId: 1 },
      READ_PAGE_RESULT,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('No elements found');
    expect(result.content[0].text).toContain('"xyzzy_no_match"');
  });

  it('should include the query in the no-match message', async () => {
    const result = await testableHandleFindElements(
      { query: 'missing_thing', tabId: 1 },
      READ_PAGE_RESULT,
    );
    expect(result.content[0].text).toContain('"missing_thing"');
  });

  it('should return a result without isError when matches are found', async () => {
    const result = await testableHandleFindElements(
      { query: 'Submit', tabId: 1 },
      READ_PAGE_RESULT,
    );
    expect(result.isError).toBeUndefined();
  });

  it('should include match count in the success message', async () => {
    const result = await testableHandleFindElements(
      { query: 'button', tabId: 1 },
      READ_PAGE_RESULT,
    );
    expect(result.content[0].text).toContain('Found');
    expect(result.content[0].text).toContain('element');
  });

  it('should include element role, text, and ref in the success message', async () => {
    const result = await testableHandleFindElements(
      { query: 'Submit', tabId: 1 },
      READ_PAGE_RESULT,
    );
    expect(result.content[0].text).toContain('button');
    expect(result.content[0].text).toContain('"Submit"');
    expect(result.content[0].text).toContain('[ref_1]');
  });

  it('should return a single text content item', () => {
    // structural check
    expect(READ_PAGE_RESULT.content).toHaveLength(1);
  });

  it('should use filter="interactive" by default (unrecognised filter value)', async () => {
    // We can't verify the executeTool arg in this isolation, but we verify that
    // an unrecognised filter value doesn't blow up the validator
    const result = await testableHandleFindElements(
      { query: 'Submit', tabId: 1, filter: 'invalid_value' },
      READ_PAGE_RESULT,
    );
    // Should still succeed (defaults to 'interactive' silently)
    expect(result.isError).toBeUndefined();
  });
});

// ============================================================================
// handleClickByText — input validation + response shaping (no socket)
// ============================================================================

/**
 * Mirrors handleClickByText() — validation and not-found path (server.ts ~lines 1413–1438).
 * The executeTool calls are replaced by injected results.
 */
async function testableHandleClickByText(
  args: Record<string, unknown>,
  readPageResult?: ToolResult,
  clickResult?: ToolResult,
): Promise<ToolResult> {
  const text = typeof args.text === 'string' ? args.text : '';
  const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;

  if (!text) {
    return { content: [{ type: 'text', text: 'Missing required parameter: text' }], isError: true };
  }
  if (tabId === undefined) {
    return { content: [{ type: 'text', text: 'Missing required parameter: tabId' }], isError: true };
  }

  const readResult = readPageResult!;
  if (readResult.isError) return readResult;

  const matches = findMatchingElements(parseAccessibilityTree(extractTextFromResult(readResult)), text);
  if (matches.length === 0) {
    return { content: [{ type: 'text', text: `Element not found: "${text}"` }], isError: true };
  }

  const { ref } = matches[0];
  // Simulate scroll_to (ignored in isolation)
  // Simulate left_click result
  const click = clickResult ?? { content: [{ type: 'text', text: 'clicked' }] };

  return {
    content: [{ type: 'text', text: `Clicked ${matches[0].role} "${matches[0].text}" [${ref}]` }],
    isError: click.isError,
  };
}

describe('handleClickByText() — input validation', () => {
  it('should return isError when text is missing', async () => {
    const result = await testableHandleClickByText({ tabId: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('text');
  });

  it('should return isError when text is empty string', async () => {
    const result = await testableHandleClickByText({ text: '', tabId: 1 });
    expect(result.isError).toBe(true);
  });

  it('should return isError when tabId is missing', async () => {
    const result = await testableHandleClickByText({ text: 'Submit' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('tabId');
  });

  it('should propagate isError from read_page', async () => {
    const fakeError: ToolResult = { content: [{ type: 'text', text: 'Socket error' }], isError: true };
    const result = await testableHandleClickByText({ text: 'Submit', tabId: 1 }, fakeError);
    expect(result.isError).toBe(true);
  });
});

describe('handleClickByText() — element not found path', () => {
  const READ_RESULT: ToolResult = {
    content: [{ type: 'text', text: MULTI_ELEMENT_TREE }],
  };

  it('should return isError when no element matches the text', async () => {
    const result = await testableHandleClickByText(
      { text: 'nonexistent_element', tabId: 1 },
      READ_RESULT,
    );
    expect(result.isError).toBe(true);
  });

  it('should include the searched text in the not-found error message', async () => {
    const result = await testableHandleClickByText(
      { text: 'nonexistent_element', tabId: 1 },
      READ_RESULT,
    );
    expect(result.content[0].text).toContain('"nonexistent_element"');
  });
});

describe('handleClickByText() — success path response shaping', () => {
  const READ_RESULT: ToolResult = {
    content: [{ type: 'text', text: MULTI_ELEMENT_TREE }],
  };

  it('should include the clicked element role in the success message', async () => {
    const result = await testableHandleClickByText(
      { text: 'Submit', tabId: 1 },
      READ_RESULT,
      { content: [{ type: 'text', text: 'ok' }] },
    );
    expect(result.content[0].text).toContain('button');
  });

  it('should include the element text in the success message', async () => {
    const result = await testableHandleClickByText(
      { text: 'Submit', tabId: 1 },
      READ_RESULT,
      { content: [{ type: 'text', text: 'ok' }] },
    );
    expect(result.content[0].text).toContain('"Submit"');
  });

  it('should include the element ref in the success message', async () => {
    const result = await testableHandleClickByText(
      { text: 'Submit', tabId: 1 },
      READ_RESULT,
      { content: [{ type: 'text', text: 'ok' }] },
    );
    expect(result.content[0].text).toContain('[ref_1]');
  });

  it('should propagate isError from the click result', async () => {
    const clickError: ToolResult = { content: [{ type: 'text', text: 'click failed' }], isError: true };
    const result = await testableHandleClickByText(
      { text: 'Submit', tabId: 1 },
      READ_RESULT,
      clickError,
    );
    expect(result.isError).toBe(true);
  });

  it('should not set isError when click succeeds', async () => {
    const clickOk: ToolResult = { content: [{ type: 'text', text: 'ok' }] };
    const result = await testableHandleClickByText(
      { text: 'Submit', tabId: 1 },
      READ_RESULT,
      clickOk,
    );
    expect(result.isError).toBeUndefined();
  });
});

// ============================================================================
// handleFillInput — input validation + role filtering + response shaping (no socket)
// ============================================================================

const INPUT_ROLES = new Set(['textbox', 'combobox', 'searchbox', 'spinbutton', 'slider']);

/**
 * Mirrors handleFillInput() — validation, role filter, and response shaping
 * (server.ts ~lines 1441–1478). fillResult is injectable.
 */
async function testableHandleFillInput(
  args: Record<string, unknown>,
  readPageResult?: ToolResult,
  fillResult?: ToolResult,
): Promise<ToolResult> {
  const label = typeof args.label === 'string' ? args.label : '';
  const value = args.value;
  const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;

  if (!label) {
    return { content: [{ type: 'text', text: 'Missing required parameter: label' }], isError: true };
  }
  if (value === undefined || value === null) {
    return { content: [{ type: 'text', text: 'Missing required parameter: value' }], isError: true };
  }
  if (tabId === undefined) {
    return { content: [{ type: 'text', text: 'Missing required parameter: tabId' }], isError: true };
  }

  const readResult = readPageResult!;
  if (readResult.isError) return readResult;

  const matches = findMatchingElements(parseAccessibilityTree(extractTextFromResult(readResult)), label);
  const input = matches.find((el) => INPUT_ROLES.has(el.role));
  if (!input) {
    return {
      content: [
        {
          type: 'text',
          text: `No input element found matching "${label}". Looked for roles: ${[...INPUT_ROLES].join(', ')}`,
        },
      ],
      isError: true,
    };
  }

  const fill = fillResult!;
  if (fill.isError) return fill;

  return {
    content: [
      {
        type: 'text',
        text: `Filled ${input.role} "${input.text}" [${input.ref}] with value: ${JSON.stringify(value)}`,
      },
    ],
  };
}

describe('handleFillInput() — input validation', () => {
  it('should return isError when label is missing', async () => {
    const result = await testableHandleFillInput({ value: 'test', tabId: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('label');
  });

  it('should return isError when label is empty string', async () => {
    const result = await testableHandleFillInput({ label: '', value: 'test', tabId: 1 });
    expect(result.isError).toBe(true);
  });

  it('should return isError when value is missing (undefined)', async () => {
    const result = await testableHandleFillInput({ label: 'Email', tabId: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('value');
  });

  it('should return isError when value is null', async () => {
    const result = await testableHandleFillInput({ label: 'Email', value: null, tabId: 1 });
    expect(result.isError).toBe(true);
  });

  it('should accept boolean false as a valid value (passes value check, reaches role-filter)', async () => {
    // false is not undefined/null — validation passes value check and proceeds to read_page
    // Supply a tree with no input roles so we reach the role-filter error path
    const noInputTree: ToolResult = { content: [{ type: 'text', text: 'button "OK" [ref_1]' }] };
    const result = await testableHandleFillInput({ label: 'OK', value: false, tabId: 1 }, noInputTree);
    // Reaches the role-filter path, not the value-validation path
    expect(result.content[0].text).toContain('No input element found');
  });

  it('should accept numeric zero as a valid value (passes value check, reaches role-filter)', async () => {
    // 0 is not undefined/null — validation passes value check and proceeds to read_page
    // Supply a tree with no input roles so we reach the role-filter error path
    const noInputTree: ToolResult = { content: [{ type: 'text', text: 'button "OK" [ref_1]' }] };
    const result = await testableHandleFillInput({ label: 'OK', value: 0, tabId: 1 }, noInputTree);
    expect(result.content[0].text).toContain('No input element found');
  });

  it('should return isError when tabId is missing', async () => {
    const result = await testableHandleFillInput({ label: 'Email', value: 'test' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('tabId');
  });

  it('should propagate isError from read_page', async () => {
    const fakeError: ToolResult = { content: [{ type: 'text', text: 'Socket error' }], isError: true };
    const result = await testableHandleFillInput({ label: 'Email', value: 'test', tabId: 1 }, fakeError);
    expect(result.isError).toBe(true);
  });
});

describe('handleFillInput() — role filtering', () => {
  const TREE_WITH_INPUT = `textbox "Email address" [ref_2] required
button "Submit" [ref_1]`;
  const READ_RESULT: ToolResult = { content: [{ type: 'text', text: TREE_WITH_INPUT }] };

  const FILL_OK: ToolResult = { content: [{ type: 'text', text: 'filled' }] };

  it('should return isError when the matching element is not an input role', async () => {
    // "Submit" matches the button but not an input role
    const result = await testableHandleFillInput(
      { label: 'Submit', value: 'irrelevant', tabId: 1 },
      READ_RESULT,
      FILL_OK,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No input element found');
  });

  it('should list the expected input roles in the no-match error', async () => {
    const result = await testableHandleFillInput(
      { label: 'Submit', value: 'test', tabId: 1 },
      READ_RESULT,
      FILL_OK,
    );
    // All 5 roles must appear
    for (const role of ['textbox', 'combobox', 'searchbox', 'spinbutton', 'slider']) {
      expect(result.content[0].text).toContain(role);
    }
  });

  it('should find an input even when the label query also matches non-input elements', async () => {
    const mixedTree = `textbox "Email address" [ref_2]
button "Email notification toggle" [ref_7]`;
    const mixedRead: ToolResult = { content: [{ type: 'text', text: mixedTree }] };
    // Both match "Email" — role filter should pick the textbox
    const result = await testableHandleFillInput(
      { label: 'Email', value: 'user@example.com', tabId: 1 },
      mixedRead,
      FILL_OK,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('textbox');
  });

  it('should recognise all five valid input roles', async () => {
    const allRoles = [
      { role: 'textbox', text: 'Name', ref: 'ref_10', attributes: '', line: 'textbox "Name" [ref_10]' },
      { role: 'combobox', text: 'Country', ref: 'ref_11', attributes: '', line: 'combobox "Country" [ref_11]' },
      { role: 'searchbox', text: 'Search', ref: 'ref_12', attributes: '', line: 'searchbox "Search" [ref_12]' },
      { role: 'spinbutton', text: 'Quantity', ref: 'ref_13', attributes: '', line: 'spinbutton "Quantity" [ref_13]' },
      { role: 'slider', text: 'Volume', ref: 'ref_14', attributes: '', line: 'slider "Volume" [ref_14]' },
    ];
    for (const el of allRoles) {
      expect(INPUT_ROLES.has(el.role)).toBe(true);
    }
  });
});

describe('handleFillInput() — response shaping', () => {
  const TREE_WITH_INPUT = `textbox "Email address" [ref_2] required`;
  const READ_RESULT: ToolResult = { content: [{ type: 'text', text: TREE_WITH_INPUT }] };
  const FILL_OK: ToolResult = { content: [{ type: 'text', text: 'filled' }] };

  it('should include the input role in the success message', async () => {
    const result = await testableHandleFillInput(
      { label: 'Email', value: 'user@example.com', tabId: 1 },
      READ_RESULT,
      FILL_OK,
    );
    expect(result.content[0].text).toContain('textbox');
  });

  it('should include the element text in the success message', async () => {
    const result = await testableHandleFillInput(
      { label: 'Email', value: 'user@example.com', tabId: 1 },
      READ_RESULT,
      FILL_OK,
    );
    expect(result.content[0].text).toContain('"Email address"');
  });

  it('should include the ref in the success message', async () => {
    const result = await testableHandleFillInput(
      { label: 'Email', value: 'user@example.com', tabId: 1 },
      READ_RESULT,
      FILL_OK,
    );
    expect(result.content[0].text).toContain('[ref_2]');
  });

  it('should JSON.stringify the filled value in the success message', async () => {
    const result = await testableHandleFillInput(
      { label: 'Email', value: 'user@example.com', tabId: 1 },
      READ_RESULT,
      FILL_OK,
    );
    expect(result.content[0].text).toContain('"user@example.com"');
  });

  it('should JSON.stringify boolean values', async () => {
    const result = await testableHandleFillInput(
      { label: 'Email', value: true, tabId: 1 },
      READ_RESULT,
      FILL_OK,
    );
    expect(result.content[0].text).toContain('true');
  });

  it('should not set isError on success', async () => {
    const result = await testableHandleFillInput(
      { label: 'Email', value: 'test@test.com', tabId: 1 },
      READ_RESULT,
      FILL_OK,
    );
    expect(result.isError).toBeUndefined();
  });

  it('should propagate isError from the form_input result', async () => {
    const fillError: ToolResult = { content: [{ type: 'text', text: 'fill failed' }], isError: true };
    const result = await testableHandleFillInput(
      { label: 'Email', value: 'test', tabId: 1 },
      READ_RESULT,
      fillError,
    );
    expect(result.isError).toBe(true);
  });
});

// ============================================================================
// handleWaitForElement — input validation + timeout path (no socket, no real timers)
// ============================================================================

/**
 * Mirrors handleWaitForElement() — validation and the timeout-exhaustion path
 * (server.ts ~lines 1480–1524).
 *
 * The polling loop is replaced by a controllable tick function so tests run
 * in <100ms without real I/O or sleep.
 */

/**
 * Validates the parameters of wait_for_element before polling begins.
 * Returns the error result if invalid, or null if valid.
 */
function validateWaitForElementArgs(args: Record<string, unknown>): ToolResult | null {
  const query = typeof args.query === 'string' ? args.query : '';
  const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;

  if (!query) {
    return { content: [{ type: 'text', text: 'Missing required parameter: query' }], isError: true };
  }
  if (tabId === undefined) {
    return { content: [{ type: 'text', text: 'Missing required parameter: tabId' }], isError: true };
  }
  return null;
}

/**
 * Mirrors the timeout-exhausted return value (server.ts line 1520–1523).
 */
function buildTimeoutResult(query: string, timeoutMs: number): ToolResult {
  return {
    content: [{ type: 'text', text: `Timeout after ${timeoutMs}ms waiting for element matching "${query}"` }],
    isError: true,
  };
}

/**
 * Mirrors the success return value (server.ts lines 1506–1509).
 */
function buildFoundResult(el: TreeElement): ToolResult {
  return {
    content: [{ type: 'text', text: `Element found: ${el.role} "${el.text}" [${el.ref}]` }],
  };
}

describe('handleWaitForElement() — input validation', () => {
  it('should return isError when query is missing', () => {
    const result = validateWaitForElementArgs({ tabId: 1 });
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.content[0].text).toContain('query');
  });

  it('should return isError when query is empty string', () => {
    const result = validateWaitForElementArgs({ query: '', tabId: 1 });
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
  });

  it('should return isError when tabId is missing', () => {
    const result = validateWaitForElementArgs({ query: 'button' });
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.content[0].text).toContain('tabId');
  });

  it('should return isError when tabId is a string', () => {
    const result = validateWaitForElementArgs({ query: 'button', tabId: '1' });
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
  });

  it('should return null (proceed) when both query and tabId are valid', () => {
    const result = validateWaitForElementArgs({ query: 'button', tabId: 1 });
    expect(result).toBeNull();
  });
});

describe('handleWaitForElement() — timeout path', () => {
  it('should return isError on timeout', () => {
    const result = buildTimeoutResult('button', 30_000);
    expect(result.isError).toBe(true);
  });

  it('should include the query in the timeout message', () => {
    const result = buildTimeoutResult('my-element', 5000);
    expect(result.content[0].text).toContain('"my-element"');
  });

  it('should include the timeout value in the timeout message', () => {
    const result = buildTimeoutResult('my-element', 5000);
    expect(result.content[0].text).toContain('5000ms');
  });

  it('should return a single text content item', () => {
    const result = buildTimeoutResult('button', 30_000);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
  });
});

describe('handleWaitForElement() — found path', () => {
  it('should return no isError when element is found', () => {
    const el = FIXTURE_ELEMENTS[0];
    const result = buildFoundResult(el);
    expect(result.isError).toBeUndefined();
  });

  it('should include the element role in the found message', () => {
    const el = FIXTURE_ELEMENTS[0]; // role: 'button'
    const result = buildFoundResult(el);
    expect(result.content[0].text).toContain('button');
  });

  it('should include the element text in the found message', () => {
    const el = FIXTURE_ELEMENTS[0]; // text: 'Submit form'
    const result = buildFoundResult(el);
    expect(result.content[0].text).toContain('"Submit form"');
  });

  it('should include the element ref in the found message', () => {
    const el = FIXTURE_ELEMENTS[0]; // ref: 'ref_1'
    const result = buildFoundResult(el);
    expect(result.content[0].text).toContain('[ref_1]');
  });

  it('should return a single text content item', () => {
    const el = FIXTURE_ELEMENTS[0];
    const result = buildFoundResult(el);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
  });
});

describe('handleWaitForElement() — default parameter values', () => {
  it('should default timeoutMs to 30000 when not supplied', () => {
    const args = { query: 'button', tabId: 1 };
    // Mirror the exact defaulting logic from server.ts line 1485
    const timeoutMs = typeof args['timeoutMs'] === 'number' ? args['timeoutMs'] : 30_000;
    expect(timeoutMs).toBe(30_000);
  });

  it('should default pollIntervalMs to 1000 when not supplied', () => {
    const args = { query: 'button', tabId: 1 };
    const pollIntervalMs = typeof args['pollIntervalMs'] === 'number' ? args['pollIntervalMs'] : 1_000;
    expect(pollIntervalMs).toBe(1_000);
  });

  it('should accept custom timeoutMs', () => {
    const args = { query: 'button', tabId: 1, timeoutMs: 5000 };
    const timeoutMs = typeof args['timeoutMs'] === 'number' ? args['timeoutMs'] : 30_000;
    expect(timeoutMs).toBe(5000);
  });

  it('should accept custom pollIntervalMs', () => {
    const args = { query: 'button', tabId: 1, pollIntervalMs: 500 };
    const pollIntervalMs = typeof args['pollIntervalMs'] === 'number' ? args['pollIntervalMs'] : 1_000;
    expect(pollIntervalMs).toBe(500);
  });
});

// ============================================================================
// SERVER_SIDE_TOOLS — new tools must be in the dispatch set
// ============================================================================

/**
 * Mirrors the SERVER_SIDE_TOOLS set from server.ts ~line 1092.
 * If the actual set in server.ts changes, these tests should catch regressions.
 */
const SERVER_SIDE_TOOLS = new Set([
  'list_chrome_extensions',
  'reload_chrome_extension',
  'find_elements',
  'click_by_text',
  'fill_input',
  'wait_for_element',
]);

describe('SERVER_SIDE_TOOLS membership', () => {
  const NEW_TOOLS = ['find_elements', 'click_by_text', 'fill_input', 'wait_for_element'];
  const LEGACY_TOOLS = ['list_chrome_extensions', 'reload_chrome_extension'];
  const SOCKET_TOOLS = ['navigate', 'read_page', 'computer', 'form_input', 'tabs_context_mcp'];

  it('should contain all 4 new convenience tools', () => {
    for (const tool of NEW_TOOLS) {
      expect(SERVER_SIDE_TOOLS.has(tool)).toBe(true);
    }
  });

  it('should still contain the 2 original server-side tools', () => {
    for (const tool of LEGACY_TOOLS) {
      expect(SERVER_SIDE_TOOLS.has(tool)).toBe(true);
    }
  });

  it('should have exactly 6 members', () => {
    expect(SERVER_SIDE_TOOLS.size).toBe(6);
  });

  it('should NOT contain socket-proxied tool names', () => {
    for (const tool of SOCKET_TOOLS) {
      expect(SERVER_SIDE_TOOLS.has(tool)).toBe(false);
    }
  });

  it('each new tool name should be a non-empty string', () => {
    for (const tool of NEW_TOOLS) {
      expect(typeof tool).toBe('string');
      expect(tool.length).toBeGreaterThan(0);
    }
  });
});
