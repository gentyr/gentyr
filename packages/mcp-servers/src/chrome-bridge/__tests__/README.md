# Chrome Bridge MCP Server - Test Suite

## Overview

Test coverage for the chrome-bridge MCP server, focusing on the `normalizeResponse` method that handles responses from the Claude Chrome Extension.

## Test Files

### `normalizeResponse.test.ts`

**Purpose:** Unit tests for the bug fix that resolved "content.map is not a function" error.

**Bug Fixed:** The chrome-bridge server was calling `.map()` on `response.result.content` and `response.error.content` without checking if they were arrays. The Chrome extension can return content as:
- `McpContent[]` (array)
- `McpContent` (single object)
- `string` (plain text)

**Fix Applied:**
```typescript
// Before (caused crash on non-array content)
const content = response.result.content.map(...)

// After (handles all three formats)
const rawContent = response.result.content;
const content = Array.isArray(rawContent)
  ? rawContent
  : rawContent != null
    ? [rawContent]
    : [];
```

## Test Coverage

### Test Categories

1. **Success Response - Array Content** (3 tests)
   - Array of McpContent objects
   - Empty arrays
   - Mixed content types (text + image)

2. **Success Response - Single McpContent** (3 tests)
   - Single text content object (core bug fix validation)
   - Single image content object
   - Non-array content handling

3. **Success Response - String Content** (3 tests)
   - Plain string responses (core bug fix validation)
   - Empty strings
   - Numeric strings

4. **Success Response - Image Transformations** (3 tests)
   - Image with `source.data` object (Chrome extension format)
   - Image with `source.media_type` extraction
   - Image already in flat structure

5. **Error Response - Array Content** (2 tests)
   - Array of error messages
   - Empty error arrays

6. **Error Response - Single McpContent** (2 tests)
   - Single error object (core bug fix validation)
   - Non-typed error objects

7. **Error Response - String Content** (2 tests)
   - Plain string errors (core bug fix validation)
   - Multiline error messages

8. **Edge Cases - Type Validation** (7 tests)
   - Null/undefined content handling
   - Number/boolean content conversion
   - Mixed array content types
   - Type validation after normalization

9. **Edge Cases - Empty Responses** (3 tests)
   - Response with neither result nor error
   - Empty result objects
   - Empty error objects

10. **Structure Validation** (2 tests)
    - Structure validation vs. performance testing
    - Malformed response handling

11. **Array.isArray Checks** (2 tests)
    - Validates fix uses `Array.isArray()` for result.content
    - Validates fix uses `Array.isArray()` for error.content

**Total Tests:** 31

## Testing Philosophy

These tests follow the GENTYR testing policy:

1. **Validate Structure, Not Performance**
   - Tests validate response structure is correct
   - Do NOT test data quality, accuracy, or performance
   - Example: Text content can be nonsense - we only validate it's properly wrapped in `{ type: 'text', text: '...' }`

2. **Fail Loudly - No Graceful Fallbacks**
   - Tests expect errors to throw, not return undefined
   - No silent failures allowed

3. **Never Make Tests Easier to Pass**
   - Tests were written AFTER the fix was implemented
   - No test assertions were weakened to make them pass
   - All 31 tests pass on first run after bug fix

4. **Coverage Requirements**
   - 100% coverage of `normalizeResponse` method
   - All three content type formats tested (array, object, string)
   - Both success and error paths covered

## Running Tests

```bash
# Run all chrome-bridge tests
npm test -- src/chrome-bridge/__tests__/

# Run just normalizeResponse tests
npm test -- src/chrome-bridge/__tests__/normalizeResponse.test.ts

# Run with coverage
npm test -- src/chrome-bridge/__tests__/ -- --coverage

# Watch mode
npm run test:watch -- src/chrome-bridge/__tests__/
```

## Key Test Cases (Bug Fix Validation)

The following tests specifically validate the bug fix:

1. **Single McpContent Object (NOT array)**
   ```typescript
   // Chrome extension returns: { type: 'text', text: 'message' }
   // NOT: [{ type: 'text', text: 'message' }]
   ```
   Tests: Lines 91-124

2. **Plain String Content (NOT array)**
   ```typescript
   // Chrome extension returns: "Plain text response"
   // NOT: [{ type: 'text', text: 'Plain text response' }]
   ```
   Tests: Lines 126-160

3. **Array.isArray() Usage**
   ```typescript
   // Validates fix checks Array.isArray() before calling .map()
   ```
   Tests: Lines 570-614

## Future Test Additions

If additional chrome-bridge functionality is added, consider these test areas:

1. **Integration Tests** (opportunistic)
   - Test with real Chrome extension responses
   - Validate socket communication protocol
   - Test tab routing logic

2. **Error Handling**
   - Connection timeout scenarios
   - Socket disconnection recovery
   - Invalid JSON-RPC responses

3. **Tool Execution**
   - Execute each of the 18 available tools
   - Validate tool parameter schemas
   - Test tool error responses

**Note:** Integration tests MUST follow G012 (Non-Destructive Integration Testing):
- Read-only operations only
- Human-like delays between actions
- Rate limiting compliance
- No permanent artifacts
