/**
 * Unit tests for the Icon Processor MCP Server
 *
 * Tests Simple Icons lookup, image analysis, background removal,
 * PNG→SVG tracing, SVG normalization, optimization, and structure analysis.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { server, setIconsDir } from '../server.js';
import type { McpServer } from '../../shared/server.js';

// ============================================================================
// Helpers
// ============================================================================

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: {
    code: number;
    message: string;
  };
}

function tmpPath(ext: string = '.png'): string {
  return path.join(tmpdir(), `icon-test-${randomUUID()}${ext}`);
}

function tmpDir(): string {
  const dir = path.join(tmpdir(), `icon-test-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function callTool(
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const response = (await server.processRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  })) as JsonRpcResponse;

  const text = response.result?.content?.[0]?.text;
  if (!text) throw new Error(`No content in response for tool ${toolName}`);
  return JSON.parse(text);
}

/**
 * Create a minimal valid PNG file in memory using sharp.
 * Returns the buffer and the written file path.
 */
async function createTestPng(
  width: number,
  height: number,
  options?: {
    background?: { r: number; g: number; b: number; alpha?: number };
    circle?: { cx: number; cy: number; radius: number; fill: string };
  },
): Promise<{ buffer: Buffer; path: string }> {
  const sharp = (await import('sharp')).default;
  const bg = options?.background ?? { r: 255, g: 255, b: 255, alpha: 1 };

  let img = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: bg,
    },
  });

  // Overlay a circle if requested
  if (options?.circle) {
    const { cx, cy, radius, fill } = options.circle;
    const svgOverlay = `<svg width="${width}" height="${height}">
      <circle cx="${cx}" cy="${cy}" r="${radius}" fill="${fill}" />
    </svg>`;
    img = img.composite([{ input: Buffer.from(svgOverlay), blend: 'over' }]);
  }

  const buffer = await img.png().toBuffer();
  const filePath = tmpPath('.png');
  fs.writeFileSync(filePath, buffer);
  return { buffer, path: filePath };
}

// ============================================================================
// Test: tools/list
// ============================================================================

// ============================================================================
// Icon Store Test Helpers
// ============================================================================

let testIconsDir: string;

function setupIconsDir() {
  testIconsDir = path.join(tmpdir(), `icon-store-test-${randomUUID()}`);
  fs.mkdirSync(testIconsDir, { recursive: true });
  setIconsDir(testIconsDir);
}

function teardownIconsDir() {
  if (testIconsDir && fs.existsSync(testIconsDir)) {
    fs.rmSync(testIconsDir, { recursive: true, force: true });
  }
}

const MINIMAL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M0 0h64v64H0z" fill="#65A637"/></svg>';
const BLACK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M0 0h64v64H0z" fill="#000000"/></svg>';
const WHITE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M0 0h64v64H0z" fill="#FFFFFF"/></svg>';
const FULL_COLOR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="0" y="0" width="32" height="64" fill="#FF0000"/><rect x="32" y="0" width="32" height="64" fill="#0000FF"/></svg>';

// ============================================================================
// Tests
// ============================================================================

describe('icon-processor MCP server', () => {
  describe('tools/list', () => {
    it('should list all 12 tools', async () => {
      const response = (await server.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      })) as JsonRpcResponse;

      const tools = (response.result as { tools: Array<{ name: string }> }).tools;
      const toolNames = tools.map((t) => t.name).sort();
      expect(toolNames).toEqual([
        'analyze_image',
        'analyze_svg_structure',
        'delete_icon',
        'download_image',
        'list_icons',
        'lookup_simple_icon',
        'normalize_svg',
        'optimize_svg',
        'recolor_svg',
        'remove_background',
        'store_icon',
        'trace_to_svg',
      ]);
    });
  });

  // ============================================================================
  // Test: lookup_simple_icon
  // ============================================================================

  describe('lookup_simple_icon', () => {
    it('should find a well-known brand (GitHub)', async () => {
      const result = (await callTool('lookup_simple_icon', {
        brand_name: 'GitHub',
      })) as { found: boolean; slug?: string; title?: string; svg_content?: string; hex_color?: string };

      expect(result.found).toBe(true);
      expect(result.slug).toBe('github');
      expect(result.title).toBe('GitHub');
      expect(result.svg_content).toContain('<svg');
      expect(result.hex_color).toMatch(/^#[0-9a-fA-F]{6}$/);
    });

    it('should find by slug (case-insensitive)', async () => {
      const result = (await callTool('lookup_simple_icon', {
        brand_name: 'github',
      })) as { found: boolean; slug?: string };

      expect(result.found).toBe(true);
      expect(result.slug).toBe('github');
    });

    it('should return not found for unknown brand with suggestions', async () => {
      const result = (await callTool('lookup_simple_icon', {
        brand_name: 'xyznotarealbrandom',
      })) as { found: boolean; suggestions?: string[] };

      expect(result.found).toBe(false);
      expect(result.suggestions).toBeDefined();
    });

    it('should find Splunk', async () => {
      const result = (await callTool('lookup_simple_icon', {
        brand_name: 'Splunk',
      })) as { found: boolean; slug?: string; svg_content?: string };

      expect(result.found).toBe(true);
      expect(result.slug).toBe('splunk');
      expect(result.svg_content).toContain('<svg');
    });
  });

  // ============================================================================
  // Test: download_image
  // ============================================================================

  describe('download_image', () => {
    it('should return error for unreachable URL', async () => {
      // Use a public non-routable IP (RFC 5737 TEST-NET-1) to avoid SSRF block
      const result = (await callTool('download_image', {
        url: 'http://192.0.2.1:1/nonexistent-image.png',
        output_path: tmpPath('.png'),
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');
    });

    it('should block file:// protocol (SSRF prevention)', async () => {
      const result = (await callTool('download_image', {
        url: 'file:///etc/passwd',
        output_path: tmpPath('.txt'),
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Blocked URL protocol/);
    });

    it('should block ftp:// protocol (SSRF prevention)', async () => {
      const result = (await callTool('download_image', {
        url: 'ftp://example.com/image.png',
        output_path: tmpPath('.png'),
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Blocked URL protocol/);
    });

    it('should not write file when URL protocol is blocked', async () => {
      const outputPath = tmpPath('.png');
      await callTool('download_image', {
        url: 'file:///etc/passwd',
        output_path: outputPath,
      });

      expect(fs.existsSync(outputPath)).toBe(false);
    });

    it('should reject path traversal in output_path', async () => {
      // Use a public non-routable IP to avoid SSRF block; path traversal check fires first
      const result = (await callTool('download_image', {
        url: 'http://192.0.2.1:1/test.png',
        output_path: '/tmp/safe/../../../etc/evil.png',
      })) as { error: string };

      expect(result.error).toMatch(/Path traversal detected/);
    });

    it('should block localhost (SSRF prevention)', async () => {
      const result = (await callTool('download_image', {
        url: 'http://localhost:8080/admin',
        output_path: tmpPath('.png'),
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Blocked URL target/);
    });

    it('should block 127.0.0.1 loopback (SSRF prevention)', async () => {
      const result = (await callTool('download_image', {
        url: 'http://127.0.0.1/secret',
        output_path: tmpPath('.png'),
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Blocked URL target/);
    });

    it('should block 169.254.169.254 AWS metadata (SSRF prevention)', async () => {
      const result = (await callTool('download_image', {
        url: 'http://169.254.169.254/latest/meta-data/',
        output_path: tmpPath('.png'),
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Blocked URL target/);
    });

    it('should block 10.x.x.x private range (SSRF prevention)', async () => {
      const result = (await callTool('download_image', {
        url: 'http://10.0.0.1/internal',
        output_path: tmpPath('.png'),
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Blocked URL target/);
    });

    it('should block 192.168.x.x private range (SSRF prevention)', async () => {
      const result = (await callTool('download_image', {
        url: 'http://192.168.1.1/router',
        output_path: tmpPath('.png'),
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Blocked URL target/);
    });

    it('should block 172.16-31.x.x private range (SSRF prevention)', async () => {
      const result = (await callTool('download_image', {
        url: 'http://172.16.0.1/internal',
        output_path: tmpPath('.png'),
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Blocked URL target/);
    });

    it('should allow 172.32.x.x (outside private range)', async () => {
      // 172.32.0.1 is a public IP — should get a network error, not SSRF block
      const result = (await callTool('download_image', {
        url: 'http://172.32.0.1:1/test.png',
        output_path: tmpPath('.png'),
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).not.toMatch(/Blocked URL target/);
    });

    it('should allow 172.15.x.x (just below private range boundary)', async () => {
      const result = (await callTool('download_image', {
        url: 'http://172.15.255.1:1/test.png',
        output_path: tmpPath('.png'),
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).not.toMatch(/Blocked URL target/);
    });

    it('should block 172.31.x.x (upper boundary of private range)', async () => {
      const result = (await callTool('download_image', {
        url: 'http://172.31.255.255/internal',
        output_path: tmpPath('.png'),
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Blocked URL target/);
    });

    it('should block IPv6 loopback ::1 (SSRF prevention)', async () => {
      const result = (await callTool('download_image', {
        url: 'http://[::1]:8080/admin',
        output_path: tmpPath('.png'),
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Blocked URL target/);
    });

    it('should block IPv4-mapped IPv6 ::ffff:127.0.0.1 (SSRF bypass prevention)', async () => {
      const result = (await callTool('download_image', {
        url: 'http://[::ffff:127.0.0.1]/secret',
        output_path: tmpPath('.png'),
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Blocked URL target/);
    });

    it('should block 0.0.0.0 (SSRF prevention)', async () => {
      const result = (await callTool('download_image', {
        url: 'http://0.0.0.0/test',
        output_path: tmpPath('.png'),
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Blocked URL target/);
    });

    it('should block metadata.google.internal (SSRF prevention)', async () => {
      const result = (await callTool('download_image', {
        url: 'http://metadata.google.internal/computeMetadata/v1/',
        output_path: tmpPath('.png'),
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Blocked URL target/);
    });
  });

  // ============================================================================
  // Test: Security — assertSafePath
  // ============================================================================

  describe('security: path traversal blocking', () => {
    it('analyze_image: should reject path with .. traversal', async () => {
      const result = (await callTool('analyze_image', {
        input_path: '/tmp/icons/../../../etc/shadow',
      })) as { error: string };

      expect(result.error).toMatch(/Path traversal detected/);
    });

    it('remove_background: should reject traversal in output_path', async () => {
      const { path: inputPath } = await createTestPng(64, 64);

      const result = (await callTool('remove_background', {
        input_path: inputPath,
        output_path: '/tmp/../etc/cron.d/evil',
      })) as { error: string };

      expect(result.error).toMatch(/Path traversal detected/);
      fs.unlinkSync(inputPath);
    });

    it('normalize_svg: should reject traversal in output_path', async () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"/></svg>`;

      const result = (await callTool('normalize_svg', {
        svg_content: svg,
        output_path: '/tmp/../../etc/evil.svg',
      })) as { error: string };

      expect(result.error).toMatch(/Path traversal detected/);
    });

    it('optimize_svg: should reject traversal in output_path', async () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"/></svg>`;

      const result = (await callTool('optimize_svg', {
        svg_content: svg,
        output_path: '/tmp/../../../etc/evil.svg',
      })) as { error: string };

      expect(result.error).toMatch(/Path traversal detected/);
    });

    it('clean absolute paths should pass validation', async () => {
      const outputPath = tmpPath('.svg');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>`;

      const result = (await callTool('optimize_svg', {
        svg_content: svg,
        output_path: outputPath,
      })) as { success: boolean };

      expect(result.success).toBe(true);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    });
  });

  // ============================================================================
  // Test: analyze_image
  // ============================================================================

  describe('analyze_image', () => {
    it('should detect a white background PNG', async () => {
      const { path: imgPath } = await createTestPng(64, 64, {
        background: { r: 255, g: 255, b: 255 },
        circle: { cx: 32, cy: 32, radius: 20, fill: 'red' },
      });

      const result = (await callTool('analyze_image', {
        input_path: imgPath,
      })) as { width: number; height: number; estimated_background: string; background_color?: { hex: string } };

      expect(result.width).toBe(64);
      expect(result.height).toBe(64);
      // With a circle in the middle, corners are white = solid background
      expect(result.estimated_background).toBe('solid');
      expect(result.background_color).toBeDefined();
      expect(result.background_color!.hex).toBe('#ffffff');

      fs.unlinkSync(imgPath);
    });

    it('should detect a transparent background PNG', async () => {
      const sharp = (await import('sharp')).default;
      const imgPath = tmpPath('.png');

      // Create fully transparent image with a red circle
      const svgSource = `<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg">
        <circle cx="32" cy="32" r="20" fill="red" />
      </svg>`;
      await sharp(Buffer.from(svgSource)).png().toFile(imgPath);

      const result = (await callTool('analyze_image', {
        input_path: imgPath,
      })) as { estimated_background: string; has_alpha: boolean };

      expect(result.estimated_background).toBe('transparent');
      expect(result.has_alpha).toBe(true);

      fs.unlinkSync(imgPath);
    });

    it('should detect a complex background PNG', async () => {
      const sharp = (await import('sharp')).default;
      const imgPath = tmpPath('.png');

      // Create image with different colors in each corner (gradient-like)
      const svgSource = `<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="0" width="32" height="32" fill="red"/>
        <rect x="32" y="0" width="32" height="32" fill="blue"/>
        <rect x="0" y="32" width="32" height="32" fill="green"/>
        <rect x="32" y="32" width="32" height="32" fill="yellow"/>
      </svg>`;
      await sharp(Buffer.from(svgSource)).png().toFile(imgPath);

      const result = (await callTool('analyze_image', {
        input_path: imgPath,
      })) as { estimated_background: string };

      expect(result.estimated_background).toBe('complex');

      fs.unlinkSync(imgPath);
    });

    it('should return error for non-existent file', async () => {
      const result = (await callTool('analyze_image', {
        input_path: '/tmp/nonexistent-file-xyz.png',
      })) as { error: string };

      expect(result.error).toContain('File not found');
    });
  });

  // ============================================================================
  // Test: remove_background
  // ============================================================================

  describe('remove_background', () => {
    it('should remove a solid white background', async () => {
      const { path: inputPath } = await createTestPng(64, 64, {
        background: { r: 255, g: 255, b: 255 },
        circle: { cx: 32, cy: 32, radius: 20, fill: 'black' },
      });
      const outputPath = tmpPath('.png');

      const result = (await callTool('remove_background', {
        input_path: inputPath,
        output_path: outputPath,
      })) as { success: boolean; pixels_removed_percentage: number };

      expect(result.success).toBe(true);
      expect(result.pixels_removed_percentage).toBeGreaterThan(0);
      expect(fs.existsSync(outputPath)).toBe(true);

      // Verify the output has alpha channel
      const sharp = (await import('sharp')).default;
      const meta = await sharp(outputPath).metadata();
      expect(meta.channels).toBe(4);

      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
    });

    it('should return error for non-existent file', async () => {
      const result = (await callTool('remove_background', {
        input_path: '/tmp/nonexistent.png',
        output_path: tmpPath('.png'),
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain('File not found');
    });
  });

  // ============================================================================
  // Test: trace_to_svg
  // ============================================================================

  describe('trace_to_svg', () => {
    it('should return error for non-existent file', async () => {
      const result = (await callTool('trace_to_svg', {
        input_path: '/tmp/nonexistent-trace-input.png',
        output_path: tmpPath('.svg'),
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain('File not found');
    });

    it('should trace a simple shape PNG to SVG', async () => {
      const { path: inputPath } = await createTestPng(128, 128, {
        background: { r: 255, g: 255, b: 255 },
        circle: { cx: 64, cy: 64, radius: 40, fill: 'black' },
      });
      const outputPath = tmpPath('.svg');

      const result = (await callTool('trace_to_svg', {
        input_path: inputPath,
        output_path: outputPath,
      })) as { success: boolean; svg_content: string; path_count: number };

      expect(result.success).toBe(true);
      expect(result.svg_content).toContain('<svg');
      expect(result.svg_content).toContain('<path');
      expect(result.path_count).toBeGreaterThan(0);
      expect(fs.existsSync(outputPath)).toBe(true);

      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
    });
  });

  // ============================================================================
  // Test: normalize_svg
  // ============================================================================

  describe('normalize_svg', () => {
    it('should normalize an off-center SVG to square viewBox', async () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
        <path d="M 50 20 L 150 20 L 150 80 L 50 80 Z" fill="black"/>
      </svg>`;
      const outputPath = tmpPath('.svg');

      const result = (await callTool('normalize_svg', {
        svg_content: svg,
        output_path: outputPath,
        target_size: 64,
        padding_percent: 5,
      })) as { success: boolean; final_viewBox: string; original_bbox: { width: number; height: number } };

      expect(result.success).toBe(true);
      expect(result.original_bbox.width).toBeCloseTo(100, 0);
      expect(result.original_bbox.height).toBeCloseTo(60, 0);

      // The viewBox should be square
      const vbParts = result.final_viewBox.split(' ').map(Number);
      expect(vbParts[2]).toBeCloseTo(vbParts[3], 1); // width ≈ height

      expect(fs.existsSync(outputPath)).toBe(true);
      fs.unlinkSync(outputPath);
    });

    it('should return error for SVG with no paths', async () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text>Hello</text></svg>`;
      const outputPath = tmpPath('.svg');

      const result = (await callTool('normalize_svg', {
        svg_content: svg,
        output_path: outputPath,
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain('No path elements');
    });

    it('should return error for SVG with unparseable path data', async () => {
      // A path with empty d="" is extracted but svgPathBbox can't compute a bbox
      const svg = `<svg xmlns="http://www.w3.org/2000/svg"><path d="" fill="black"/></svg>`;
      const outputPath = tmpPath('.svg');

      const result = (await callTool('normalize_svg', {
        svg_content: svg,
        output_path: outputPath,
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      // The error could be "No path elements" or "Could not compute bounding box"
      // depending on whether the regex matches empty d attributes
      expect(result.error).toBeDefined();
    });
  });

  // ============================================================================
  // Test: optimize_svg
  // ============================================================================

  describe('optimize_svg', () => {
    it('should reduce SVG size by removing cruft', async () => {
      const svg = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generator: Adobe Illustrator 25.0 -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     viewBox="0 0 100 100" width="100" height="100"
     data-name="Layer 1" data-editor="inkscape">
  <metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF></metadata>
  <defs></defs>
  <path d="M 10 10 L 90 10 L 90 90 L 10 90 Z" fill="#000000"/>
</svg>`;

      const result = (await callTool('optimize_svg', {
        svg_content: svg,
      })) as { success: boolean; reduction_percent: number; svg_content: string };

      expect(result.success).toBe(true);
      expect(result.reduction_percent).toBeGreaterThan(10);
      expect(result.svg_content).toContain('<path');
      expect(result.svg_content).not.toContain('Adobe Illustrator');
      expect(result.svg_content).not.toContain('metadata');
    });

    it('should not set output_path when omitted', async () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>`;

      const result = (await callTool('optimize_svg', {
        svg_content: svg,
      })) as { success: boolean; output_path?: string };

      expect(result.success).toBe(true);
      expect(result.output_path).toBeUndefined();
    });

    it('should write to output_path when provided', async () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>`;
      const outputPath = tmpPath('.svg');

      const result = (await callTool('optimize_svg', {
        svg_content: svg,
        output_path: outputPath,
      })) as { success: boolean; output_path: string };

      expect(result.success).toBe(true);
      expect(result.output_path).toBe(outputPath);
      expect(fs.existsSync(outputPath)).toBe(true);

      fs.unlinkSync(outputPath);
    });
  });

  // ============================================================================
  // Test: analyze_svg_structure
  // ============================================================================

  // ============================================================================
  // Test: list_icons
  // ============================================================================

  describe('list_icons', () => {
    beforeEach(setupIconsDir);
    afterEach(teardownIconsDir);

    it('should return empty array when no icons exist', async () => {
      const result = (await callTool('list_icons', {})) as { icons: unknown[] };
      expect(result.icons).toEqual([]);
    });

    it('should list icons after store_icon writes one', async () => {
      // Store an icon first
      await callTool('store_icon', {
        slug: 'testbrand',
        display_name: 'Test Brand',
        brand_color: '#FF0000',
        svg_content: MINIMAL_SVG,
        source: 'test',
      });

      const result = (await callTool('list_icons', {})) as {
        icons: Array<{ slug: string; display_name: string; brand_color: string; has_black_variant: boolean }>;
      };

      expect(result.icons).toHaveLength(1);
      expect(result.icons[0].slug).toBe('testbrand');
      expect(result.icons[0].display_name).toBe('Test Brand');
      expect(result.icons[0].brand_color).toBe('#FF0000');
      expect(result.icons[0].has_black_variant).toBe(false);
    });

    it('should return has_white_variant and has_full_color_variant when all 4 variants are stored', async () => {
      await callTool('store_icon', {
        slug: 'allvariantslist',
        display_name: 'All Variants List',
        brand_color: '#65A637',
        svg_content: MINIMAL_SVG,
        black_variant_svg: BLACK_SVG,
        white_variant_svg: WHITE_SVG,
        full_color_svg: FULL_COLOR_SVG,
      });

      const result = (await callTool('list_icons', {})) as {
        icons: Array<{
          slug: string;
          has_black_variant: boolean;
          has_white_variant: boolean;
          has_full_color_variant: boolean;
        }>;
      };

      expect(result.icons).toHaveLength(1);
      const entry = result.icons[0];
      expect(entry.slug).toBe('allvariantslist');
      expect(entry.has_black_variant).toBe(true);
      expect(entry.has_white_variant).toBe(true);
      expect(entry.has_full_color_variant).toBe(true);
    });

    it('should default has_white_variant and has_full_color_variant to false for old v1.0.0 metadata without those fields', async () => {
      // Simulate a legacy metadata.json written by v1.0.0 — no has_white_variant or has_full_color_variant fields
      const legacyDir = path.join(testIconsDir, 'legacy-icon');
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, 'icon.svg'), MINIMAL_SVG, 'utf-8');
      fs.writeFileSync(
        path.join(legacyDir, 'metadata.json'),
        JSON.stringify({
          slug: 'legacy-icon',
          display_name: 'Legacy Icon',
          brand_color: '#123456',
          created_at: new Date().toISOString(),
          pipeline_version: '1.0.0',
          has_black_variant: false,
          // has_white_variant intentionally absent (old format)
          // has_full_color_variant intentionally absent (old format)
        }),
        'utf-8',
      );

      const result = (await callTool('list_icons', {})) as {
        icons: Array<{
          slug: string;
          has_white_variant: boolean;
          has_full_color_variant: boolean;
        }>;
      };

      expect(result.icons).toHaveLength(1);
      const entry = result.icons[0];
      expect(entry.slug).toBe('legacy-icon');
      // IconMetadataSchema uses .default(false) so missing fields default to false
      expect(entry.has_white_variant).toBe(false);
      expect(entry.has_full_color_variant).toBe(false);
    });

    it('should return icons sorted alphabetically by slug', async () => {
      await callTool('store_icon', { slug: 'zeta', display_name: 'Zeta', brand_color: '#000', svg_content: MINIMAL_SVG });
      await callTool('store_icon', { slug: 'alpha', display_name: 'Alpha', brand_color: '#000', svg_content: MINIMAL_SVG });
      await callTool('store_icon', { slug: 'mid', display_name: 'Mid', brand_color: '#000', svg_content: MINIMAL_SVG });

      const result = (await callTool('list_icons', {})) as { icons: Array<{ slug: string }> };
      expect(result.icons.map((i) => i.slug)).toEqual(['alpha', 'mid', 'zeta']);
    });

    it('should return has_artifacts: true and has_report: true when both are present', async () => {
      // Pre-create artifacts directory before calling store_icon
      const brandDir = path.join(testIconsDir, 'fullartifacts');
      fs.mkdirSync(path.join(brandDir, 'artifacts', 'candidates'), { recursive: true });

      await callTool('store_icon', {
        slug: 'fullartifacts',
        display_name: 'Full Artifacts',
        brand_color: '#FF0000',
        svg_content: MINIMAL_SVG,
        report_md: '# Full Artifacts Report\nDetails here.',
      });

      const result = (await callTool('list_icons', {})) as {
        icons: Array<{
          slug: string;
          has_artifacts: boolean;
          has_report: boolean;
        }>;
      };

      expect(result.icons).toHaveLength(1);
      const entry = result.icons[0];
      expect(entry.slug).toBe('fullartifacts');
      expect(entry.has_artifacts).toBe(true);
      expect(entry.has_report).toBe(true);
    });

    it('should return has_artifacts: false and has_report: false for old metadata without those fields (Zod defaults)', async () => {
      // Simulate legacy metadata.json written before has_artifacts / has_report were added
      const legacyDir = path.join(testIconsDir, 'legacy-artifacts');
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, 'icon.svg'), MINIMAL_SVG, 'utf-8');
      fs.writeFileSync(
        path.join(legacyDir, 'metadata.json'),
        JSON.stringify({
          slug: 'legacy-artifacts',
          display_name: 'Legacy Artifacts',
          brand_color: '#AABBCC',
          created_at: new Date().toISOString(),
          pipeline_version: '1.0.0',
          has_black_variant: false,
          has_white_variant: false,
          has_full_color_variant: false,
          // has_artifacts and has_report intentionally absent (old format)
        }),
        'utf-8',
      );

      const result = (await callTool('list_icons', {})) as {
        icons: Array<{
          slug: string;
          has_artifacts: boolean;
          has_report: boolean;
        }>;
      };

      expect(result.icons).toHaveLength(1);
      const entry = result.icons[0];
      expect(entry.slug).toBe('legacy-artifacts');
      // IconMetadataSchema uses .default(false) so absent fields default to false
      expect(entry.has_artifacts).toBe(false);
      expect(entry.has_report).toBe(false);
    });
  });

  // ============================================================================
  // Test: store_icon
  // ============================================================================

  describe('store_icon', () => {
    beforeEach(setupIconsDir);
    afterEach(teardownIconsDir);

    it('should create icon directory and files', async () => {
      const result = (await callTool('store_icon', {
        slug: 'splunk',
        display_name: 'Splunk',
        brand_color: '#65A637',
        svg_content: MINIMAL_SVG,
        source: 'simple-icons',
      })) as { success: boolean; slug: string; path: string };

      expect(result.success).toBe(true);
      expect(result.slug).toBe('splunk');

      // Verify icon.svg was written
      expect(fs.existsSync(path.join(testIconsDir, 'splunk', 'icon.svg'))).toBe(true);
      const iconContent = fs.readFileSync(path.join(testIconsDir, 'splunk', 'icon.svg'), 'utf-8');
      expect(iconContent).toBe(MINIMAL_SVG);

      // Verify metadata.json was written
      expect(fs.existsSync(path.join(testIconsDir, 'splunk', 'metadata.json'))).toBe(true);
      const meta = JSON.parse(fs.readFileSync(path.join(testIconsDir, 'splunk', 'metadata.json'), 'utf-8'));
      expect(meta.slug).toBe('splunk');
      expect(meta.display_name).toBe('Splunk');
      expect(meta.brand_color).toBe('#65A637');
      expect(meta.source).toBe('simple-icons');
      expect(meta.pipeline_version).toBe('1.1.0');
      expect(meta.has_black_variant).toBe(false);
      expect(meta.created_at).toBeDefined();
      expect(new Date(meta.created_at).getTime()).not.toBeNaN();
    });

    it('should create black variant when provided', async () => {
      const result = (await callTool('store_icon', {
        slug: 'splunk',
        display_name: 'Splunk',
        brand_color: '#65A637',
        svg_content: MINIMAL_SVG,
        black_variant_svg: BLACK_SVG,
      })) as { success: boolean };

      expect(result.success).toBe(true);

      // Verify icon-black.svg was written
      expect(fs.existsSync(path.join(testIconsDir, 'splunk', 'icon-black.svg'))).toBe(true);
      const blackContent = fs.readFileSync(path.join(testIconsDir, 'splunk', 'icon-black.svg'), 'utf-8');
      expect(blackContent).toBe(BLACK_SVG);

      // Metadata should reflect has_black_variant: true
      const meta = JSON.parse(fs.readFileSync(path.join(testIconsDir, 'splunk', 'metadata.json'), 'utf-8'));
      expect(meta.has_black_variant).toBe(true);
    });

    it('should create all 4 variant files when all are provided', async () => {
      const result = (await callTool('store_icon', {
        slug: 'allvariants',
        display_name: 'All Variants',
        brand_color: '#65A637',
        svg_content: MINIMAL_SVG,
        black_variant_svg: BLACK_SVG,
        white_variant_svg: WHITE_SVG,
        full_color_svg: FULL_COLOR_SVG,
      })) as { success: boolean };

      expect(result.success).toBe(true);

      // All 4 SVG files must exist on disk
      expect(fs.existsSync(path.join(testIconsDir, 'allvariants', 'icon.svg'))).toBe(true);
      expect(fs.existsSync(path.join(testIconsDir, 'allvariants', 'icon-black.svg'))).toBe(true);
      expect(fs.existsSync(path.join(testIconsDir, 'allvariants', 'icon-white.svg'))).toBe(true);
      expect(fs.existsSync(path.join(testIconsDir, 'allvariants', 'icon-full-color.svg'))).toBe(true);

      // Verify file contents were written correctly
      expect(fs.readFileSync(path.join(testIconsDir, 'allvariants', 'icon-white.svg'), 'utf-8')).toBe(WHITE_SVG);
      expect(fs.readFileSync(path.join(testIconsDir, 'allvariants', 'icon-full-color.svg'), 'utf-8')).toBe(FULL_COLOR_SVG);

      // Metadata must reflect all 4 variant flags
      const meta = JSON.parse(fs.readFileSync(path.join(testIconsDir, 'allvariants', 'metadata.json'), 'utf-8'));
      expect(meta.has_black_variant).toBe(true);
      expect(meta.has_white_variant).toBe(true);
      expect(meta.has_full_color_variant).toBe(true);
      expect(meta.pipeline_version).toBe('1.1.0');
    });

    it('should not write white or full-color variant files when only brand and black are provided', async () => {
      const result = (await callTool('store_icon', {
        slug: 'twovariant',
        display_name: 'Two Variant',
        brand_color: '#65A637',
        svg_content: MINIMAL_SVG,
        black_variant_svg: BLACK_SVG,
        // white_variant_svg intentionally omitted
        // full_color_svg intentionally omitted
      })) as { success: boolean };

      expect(result.success).toBe(true);

      // Brand and black must exist
      expect(fs.existsSync(path.join(testIconsDir, 'twovariant', 'icon.svg'))).toBe(true);
      expect(fs.existsSync(path.join(testIconsDir, 'twovariant', 'icon-black.svg'))).toBe(true);

      // White and full-color must NOT exist
      expect(fs.existsSync(path.join(testIconsDir, 'twovariant', 'icon-white.svg'))).toBe(false);
      expect(fs.existsSync(path.join(testIconsDir, 'twovariant', 'icon-full-color.svg'))).toBe(false);

      // Metadata must have the new booleans set to false
      const meta = JSON.parse(fs.readFileSync(path.join(testIconsDir, 'twovariant', 'metadata.json'), 'utf-8'));
      expect(meta.has_white_variant).toBe(false);
      expect(meta.has_full_color_variant).toBe(false);
    });

    it('should overwrite an existing icon when called again', async () => {
      await callTool('store_icon', {
        slug: 'splunk',
        display_name: 'Splunk Old',
        brand_color: '#000000',
        svg_content: BLACK_SVG,
      });

      await callTool('store_icon', {
        slug: 'splunk',
        display_name: 'Splunk New',
        brand_color: '#65A637',
        svg_content: MINIMAL_SVG,
      });

      const meta = JSON.parse(fs.readFileSync(path.join(testIconsDir, 'splunk', 'metadata.json'), 'utf-8'));
      expect(meta.display_name).toBe('Splunk New');
      expect(meta.brand_color).toBe('#65A637');
    });

    it('should remove stale variant files when re-storing without those variants', async () => {
      // First store with all 4 variants
      await callTool('store_icon', {
        slug: 'stale-cleanup',
        display_name: 'Stale Cleanup',
        brand_color: '#65A637',
        svg_content: MINIMAL_SVG,
        black_variant_svg: BLACK_SVG,
        white_variant_svg: WHITE_SVG,
        full_color_svg: FULL_COLOR_SVG,
      });

      const brandDir = path.join(testIconsDir, 'stale-cleanup');
      expect(fs.existsSync(path.join(brandDir, 'icon-black.svg'))).toBe(true);
      expect(fs.existsSync(path.join(brandDir, 'icon-white.svg'))).toBe(true);
      expect(fs.existsSync(path.join(brandDir, 'icon-full-color.svg'))).toBe(true);

      // Re-store with only brand-colored SVG (no variants at all)
      const result = (await callTool('store_icon', {
        slug: 'stale-cleanup',
        display_name: 'Stale Cleanup V2',
        brand_color: '#FF0000',
        svg_content: BLACK_SVG,
      })) as { success: boolean };

      expect(result.success).toBe(true);

      // Stale variant files must be cleaned up
      expect(fs.existsSync(path.join(brandDir, 'icon.svg'))).toBe(true);
      expect(fs.existsSync(path.join(brandDir, 'icon-black.svg'))).toBe(false);
      expect(fs.existsSync(path.join(brandDir, 'icon-white.svg'))).toBe(false);
      expect(fs.existsSync(path.join(brandDir, 'icon-full-color.svg'))).toBe(false);

      // Metadata must reflect no variants
      const meta = JSON.parse(fs.readFileSync(path.join(brandDir, 'metadata.json'), 'utf-8'));
      expect(meta.has_black_variant).toBe(false);
      expect(meta.has_white_variant).toBe(false);
      expect(meta.has_full_color_variant).toBe(false);
      expect(meta.display_name).toBe('Stale Cleanup V2');
    });

    it('should reject an invalid slug', async () => {
      let threw = false;
      try {
        await callTool('store_icon', {
          slug: '../evil',
          display_name: 'Evil',
          brand_color: '#000',
          svg_content: MINIMAL_SVG,
        });
      } catch {
        threw = true;
      }
      // Zod validation should reject slug that starts with '.'
      // The tool call response may contain an error or throw
      if (!threw) {
        // If callTool returns instead of throwing, verify the store dir was not created
        expect(fs.existsSync(path.join(testIconsDir, '../evil'))).toBe(false);
      }
    });

    it('should write report.md when report_md is provided and set has_report: true in metadata', async () => {
      const reportContent = '# Test Report\nSome content';

      const result = (await callTool('store_icon', {
        slug: 'withreport',
        display_name: 'With Report',
        brand_color: '#123456',
        svg_content: MINIMAL_SVG,
        report_md: reportContent,
      })) as { success: boolean };

      expect(result.success).toBe(true);

      // report.md must exist on disk with the exact content passed in
      const reportPath = path.join(testIconsDir, 'withreport', 'report.md');
      expect(fs.existsSync(reportPath)).toBe(true);
      expect(fs.readFileSync(reportPath, 'utf-8')).toBe(reportContent);

      // Metadata must record has_report: true
      const meta = JSON.parse(
        fs.readFileSync(path.join(testIconsDir, 'withreport', 'metadata.json'), 'utf-8'),
      );
      expect(meta.has_report).toBe(true);
    });

    it('should not write report.md when report_md is omitted and set has_report: false in metadata', async () => {
      const result = (await callTool('store_icon', {
        slug: 'noreport',
        display_name: 'No Report',
        brand_color: '#654321',
        svg_content: MINIMAL_SVG,
        // report_md intentionally omitted
      })) as { success: boolean };

      expect(result.success).toBe(true);

      // report.md must NOT be written
      const reportPath = path.join(testIconsDir, 'noreport', 'report.md');
      expect(fs.existsSync(reportPath)).toBe(false);

      // Metadata must record has_report: false
      const meta = JSON.parse(
        fs.readFileSync(path.join(testIconsDir, 'noreport', 'metadata.json'), 'utf-8'),
      );
      expect(meta.has_report).toBe(false);
    });

    it('should set has_artifacts: true in metadata when artifacts/ directory exists before store_icon is called', async () => {
      // Pre-create the artifacts/candidates/ directory to simulate an agent writing artifacts
      // before calling store_icon
      const brandDir = path.join(testIconsDir, 'withartifacts');
      fs.mkdirSync(path.join(brandDir, 'artifacts', 'candidates'), { recursive: true });

      const result = (await callTool('store_icon', {
        slug: 'withartifacts',
        display_name: 'With Artifacts',
        brand_color: '#ABCDEF',
        svg_content: MINIMAL_SVG,
      })) as { success: boolean };

      expect(result.success).toBe(true);

      // Metadata must record has_artifacts: true because artifacts/ directory is present
      const meta = JSON.parse(
        fs.readFileSync(path.join(testIconsDir, 'withartifacts', 'metadata.json'), 'utf-8'),
      );
      expect(meta.has_artifacts).toBe(true);
    });

    it('should set has_artifacts: false in metadata when no artifacts/ directory exists', async () => {
      const result = (await callTool('store_icon', {
        slug: 'noartifacts',
        display_name: 'No Artifacts',
        brand_color: '#000000',
        svg_content: MINIMAL_SVG,
        // No pre-created artifacts directory
      })) as { success: boolean };

      expect(result.success).toBe(true);

      // Metadata must record has_artifacts: false
      const meta = JSON.parse(
        fs.readFileSync(path.join(testIconsDir, 'noartifacts', 'metadata.json'), 'utf-8'),
      );
      expect(meta.has_artifacts).toBe(false);

      // artifacts/ directory must not have been created by store_icon itself
      expect(fs.existsSync(path.join(testIconsDir, 'noartifacts', 'artifacts'))).toBe(false);
    });
  });

  // ============================================================================
  // Test: delete_icon
  // ============================================================================

  describe('delete_icon', () => {
    beforeEach(setupIconsDir);
    afterEach(teardownIconsDir);

    it('should remove icon directory', async () => {
      // Store first
      await callTool('store_icon', {
        slug: 'todelete',
        display_name: 'To Delete',
        brand_color: '#123456',
        svg_content: MINIMAL_SVG,
      });
      expect(fs.existsSync(path.join(testIconsDir, 'todelete'))).toBe(true);

      const result = (await callTool('delete_icon', { slug: 'todelete' })) as { success: boolean; slug: string };

      expect(result.success).toBe(true);
      expect(result.slug).toBe('todelete');
      expect(fs.existsSync(path.join(testIconsDir, 'todelete'))).toBe(false);
    });

    it('should return error for non-existent slug', async () => {
      const result = (await callTool('delete_icon', { slug: 'doesnotexist' })) as {
        success: boolean;
        slug: string;
        error: string;
      };

      expect(result.success).toBe(false);
      expect(result.slug).toBe('doesnotexist');
      expect(result.error).toContain('Icon not found');
    });
  });

  // ============================================================================
  // Test: store_icon — slug validation (Zod schema enforcement)
  // ============================================================================

  describe('store_icon slug validation', () => {
    beforeEach(setupIconsDir);
    afterEach(teardownIconsDir);

    it('should reject slug with uppercase letters', async () => {
      let threw = false;
      let result: unknown;
      try {
        result = await callTool('store_icon', {
          slug: 'MyBrand',
          display_name: 'My Brand',
          brand_color: '#000',
          svg_content: MINIMAL_SVG,
        });
      } catch {
        threw = true;
      }
      // Zod rejects uppercase; callTool should throw or return an error
      if (!threw) {
        expect((result as { error?: string }).error).toBeDefined();
      }
      expect(fs.existsSync(path.join(testIconsDir, 'MyBrand'))).toBe(false);
    });

    it('should reject slug starting with a hyphen', async () => {
      let threw = false;
      let result: unknown;
      try {
        result = await callTool('store_icon', {
          slug: '-evil',
          display_name: 'Evil',
          brand_color: '#000',
          svg_content: MINIMAL_SVG,
        });
      } catch {
        threw = true;
      }
      if (!threw) {
        expect((result as { error?: string }).error).toBeDefined();
      }
      expect(fs.existsSync(path.join(testIconsDir, '-evil'))).toBe(false);
    });

    it('should reject slug with spaces', async () => {
      let threw = false;
      let result: unknown;
      try {
        result = await callTool('store_icon', {
          slug: 'my brand',
          display_name: 'My Brand',
          brand_color: '#000',
          svg_content: MINIMAL_SVG,
        });
      } catch {
        threw = true;
      }
      if (!threw) {
        expect((result as { error?: string }).error).toBeDefined();
      }
      expect(fs.existsSync(path.join(testIconsDir, 'my brand'))).toBe(false);
    });

    it('should accept slug with hyphens between words', async () => {
      const result = (await callTool('store_icon', {
        slug: 'my-brand',
        display_name: 'My Brand',
        brand_color: '#000',
        svg_content: MINIMAL_SVG,
      })) as { success: boolean; slug: string };

      expect(result.success).toBe(true);
      expect(result.slug).toBe('my-brand');
      expect(fs.existsSync(path.join(testIconsDir, 'my-brand', 'icon.svg'))).toBe(true);
    });

    it('should accept slug with digits', async () => {
      const result = (await callTool('store_icon', {
        slug: 'brand123',
        display_name: 'Brand 123',
        brand_color: '#000',
        svg_content: MINIMAL_SVG,
      })) as { success: boolean; slug: string };

      expect(result.success).toBe(true);
      expect(result.slug).toBe('brand123');
    });

    it('should reject slug with trailing hyphen', async () => {
      let threw = false;
      let result: unknown;
      try {
        result = await callTool('store_icon', {
          slug: 'slug-',
          display_name: 'Trailing Hyphen',
          brand_color: '#000',
          svg_content: MINIMAL_SVG,
        });
      } catch {
        threw = true;
      }
      if (!threw) {
        expect((result as { error?: string }).error).toBeDefined();
      }
      expect(fs.existsSync(path.join(testIconsDir, 'slug-'))).toBe(false);
    });

    it('should reject slug with consecutive hyphens', async () => {
      let threw = false;
      let result: unknown;
      try {
        result = await callTool('store_icon', {
          slug: 'slug--name',
          display_name: 'Consecutive Hyphens',
          brand_color: '#000',
          svg_content: MINIMAL_SVG,
        });
      } catch {
        threw = true;
      }
      if (!threw) {
        expect((result as { error?: string }).error).toBeDefined();
      }
      expect(fs.existsSync(path.join(testIconsDir, 'slug--name'))).toBe(false);
    });

    it('should reject slug that is only a hyphen', async () => {
      let threw = false;
      let result: unknown;
      try {
        result = await callTool('store_icon', {
          slug: '-',
          display_name: 'Only Hyphen',
          brand_color: '#000',
          svg_content: MINIMAL_SVG,
        });
      } catch {
        threw = true;
      }
      if (!threw) {
        expect((result as { error?: string }).error).toBeDefined();
      }
      expect(fs.existsSync(path.join(testIconsDir, '-'))).toBe(false);
    });
  });

  // ============================================================================
  // Test: store_icon — return value structure
  // ============================================================================

  describe('store_icon return value', () => {
    beforeEach(setupIconsDir);
    afterEach(teardownIconsDir);

    it('should return path pointing to the icon directory', async () => {
      const result = (await callTool('store_icon', {
        slug: 'pathtest',
        display_name: 'Path Test',
        brand_color: '#AABBCC',
        svg_content: MINIMAL_SVG,
      })) as { success: boolean; slug: string; path: string };

      expect(result.success).toBe(true);
      expect(result.path).toBe(path.join(testIconsDir, 'pathtest'));
      expect(fs.existsSync(result.path)).toBe(true);
    });

    it('should store optional source field in metadata', async () => {
      await callTool('store_icon', {
        slug: 'sourced',
        display_name: 'Sourced Brand',
        brand_color: '#000',
        svg_content: MINIMAL_SVG,
        source: 'brand-website',
      });

      const meta = JSON.parse(
        fs.readFileSync(path.join(testIconsDir, 'sourced', 'metadata.json'), 'utf-8'),
      );
      expect(meta.source).toBe('brand-website');
    });

    it('should omit source from metadata when not provided', async () => {
      await callTool('store_icon', {
        slug: 'nosource',
        display_name: 'No Source',
        brand_color: '#000',
        svg_content: MINIMAL_SVG,
        // source intentionally omitted
      });

      const meta = JSON.parse(
        fs.readFileSync(path.join(testIconsDir, 'nosource', 'metadata.json'), 'utf-8'),
      );
      // source should be undefined (absent or null) when not provided
      expect(meta.source).toBeUndefined();
    });

    it('should not write icon-black.svg when black_variant_svg is not provided', async () => {
      await callTool('store_icon', {
        slug: 'noblack',
        display_name: 'No Black',
        brand_color: '#FF0000',
        svg_content: MINIMAL_SVG,
      });

      expect(fs.existsSync(path.join(testIconsDir, 'noblack', 'icon-black.svg'))).toBe(false);
    });

    it('should overwrite icon-black.svg when re-storing with a new black variant', async () => {
      const UPDATED_BLACK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M0 0h32v64H0z" fill="#000000"/></svg>';

      await callTool('store_icon', {
        slug: 'updateblack',
        display_name: 'Update Black',
        brand_color: '#FF0000',
        svg_content: MINIMAL_SVG,
        black_variant_svg: BLACK_SVG,
      });

      await callTool('store_icon', {
        slug: 'updateblack',
        display_name: 'Update Black',
        brand_color: '#FF0000',
        svg_content: MINIMAL_SVG,
        black_variant_svg: UPDATED_BLACK,
      });

      const blackContent = fs.readFileSync(
        path.join(testIconsDir, 'updateblack', 'icon-black.svg'),
        'utf-8',
      );
      expect(blackContent).toBe(UPDATED_BLACK);
    });

    it('should set has_black_variant false in metadata when overwriting without black variant', async () => {
      // Store with black variant first
      await callTool('store_icon', {
        slug: 'removeblack',
        display_name: 'Remove Black',
        brand_color: '#000',
        svg_content: MINIMAL_SVG,
        black_variant_svg: BLACK_SVG,
      });

      // Re-store without black variant
      await callTool('store_icon', {
        slug: 'removeblack',
        display_name: 'Remove Black',
        brand_color: '#000',
        svg_content: MINIMAL_SVG,
        // black_variant_svg omitted
      });

      const meta = JSON.parse(
        fs.readFileSync(path.join(testIconsDir, 'removeblack', 'metadata.json'), 'utf-8'),
      );
      expect(meta.has_black_variant).toBe(false);
    });
  });

  // ============================================================================
  // Test: list_icons — fallback paths (no metadata, malformed metadata)
  // ============================================================================

  describe('list_icons fallback paths', () => {
    beforeEach(setupIconsDir);
    afterEach(teardownIconsDir);

    it('should include directory with no metadata.json with slug as display_name', async () => {
      // Create a bare icon directory without running store_icon
      const bareDir = path.join(testIconsDir, 'bareicon');
      fs.mkdirSync(bareDir, { recursive: true });
      fs.writeFileSync(path.join(bareDir, 'icon.svg'), MINIMAL_SVG, 'utf-8');
      // Intentionally no metadata.json

      const result = (await callTool('list_icons', {})) as {
        icons: Array<{
          slug: string;
          display_name: string;
          brand_color: string;
          has_black_variant: boolean;
        }>;
      };

      expect(result.icons).toHaveLength(1);
      expect(result.icons[0].slug).toBe('bareicon');
      expect(result.icons[0].display_name).toBe('bareicon');
      expect(result.icons[0].brand_color).toBe('#000000');
      expect(result.icons[0].has_black_variant).toBe(false);
    });

    it('should detect has_black_variant from filesystem when metadata is absent', async () => {
      const bareDir = path.join(testIconsDir, 'bareblack');
      fs.mkdirSync(bareDir, { recursive: true });
      fs.writeFileSync(path.join(bareDir, 'icon.svg'), MINIMAL_SVG, 'utf-8');
      fs.writeFileSync(path.join(bareDir, 'icon-black.svg'), BLACK_SVG, 'utf-8');
      // No metadata.json

      const result = (await callTool('list_icons', {})) as {
        icons: Array<{ slug: string; has_black_variant: boolean }>;
      };

      expect(result.icons[0].slug).toBe('bareblack');
      expect(result.icons[0].has_black_variant).toBe(true);
    });

    it('should handle malformed metadata.json with slug fallback', async () => {
      const brokenDir = path.join(testIconsDir, 'brokenicon');
      fs.mkdirSync(brokenDir, { recursive: true });
      fs.writeFileSync(path.join(brokenDir, 'icon.svg'), MINIMAL_SVG, 'utf-8');
      fs.writeFileSync(path.join(brokenDir, 'metadata.json'), '{not valid json', 'utf-8');

      const result = (await callTool('list_icons', {})) as {
        icons: Array<{ slug: string; display_name: string; brand_color: string }>;
      };

      expect(result.icons).toHaveLength(1);
      expect(result.icons[0].slug).toBe('brokenicon');
      expect(result.icons[0].display_name).toBe('brokenicon');
      expect(result.icons[0].brand_color).toBe('#000000');
    });

    it('should detect has_black_variant from filesystem when metadata is malformed', async () => {
      const brokenDir = path.join(testIconsDir, 'brokenblack');
      fs.mkdirSync(brokenDir, { recursive: true });
      fs.writeFileSync(path.join(brokenDir, 'icon.svg'), MINIMAL_SVG, 'utf-8');
      fs.writeFileSync(path.join(brokenDir, 'icon-black.svg'), BLACK_SVG, 'utf-8');
      fs.writeFileSync(path.join(brokenDir, 'metadata.json'), '{not valid json', 'utf-8');

      const result = (await callTool('list_icons', {})) as {
        icons: Array<{ slug: string; has_black_variant: boolean }>;
      };

      expect(result.icons[0].has_black_variant).toBe(true);
    });

    it('should skip non-directory entries in the icons dir', async () => {
      // Store a real icon
      await callTool('store_icon', {
        slug: 'realicon',
        display_name: 'Real Icon',
        brand_color: '#123456',
        svg_content: MINIMAL_SVG,
      });

      // Place a loose file directly in the icons dir (not a subdir)
      fs.writeFileSync(path.join(testIconsDir, 'readme.txt'), 'This is not an icon', 'utf-8');

      const result = (await callTool('list_icons', {})) as {
        icons: Array<{ slug: string }>;
      };

      // The loose file must not appear as an icon entry
      const slugs = result.icons.map((i) => i.slug);
      expect(slugs).toContain('realicon');
      expect(slugs).not.toContain('readme.txt');
    });

    it('should include source field from metadata when present', async () => {
      await callTool('store_icon', {
        slug: 'withsource',
        display_name: 'With Source',
        brand_color: '#FF0000',
        svg_content: MINIMAL_SVG,
        source: 'simple-icons',
      });

      const result = (await callTool('list_icons', {})) as {
        icons: Array<{ slug: string; source?: string }>;
      };

      expect(result.icons[0].source).toBe('simple-icons');
    });

    it('should not include source field when absent from metadata', async () => {
      await callTool('store_icon', {
        slug: 'nosource2',
        display_name: 'No Source 2',
        brand_color: '#0000FF',
        svg_content: MINIMAL_SVG,
        // source intentionally omitted
      });

      const result = (await callTool('list_icons', {})) as {
        icons: Array<{ slug: string; source?: string }>;
      };

      expect(result.icons[0].source).toBeUndefined();
    });

    it('should use directory name as slug even when metadata.json has a different slug field', async () => {
      // Write metadata.json with a tampered slug field; the directory is named "real-slug"
      const iconDir = path.join(testIconsDir, 'real-slug');
      fs.mkdirSync(iconDir, { recursive: true });
      fs.writeFileSync(path.join(iconDir, 'icon.svg'), MINIMAL_SVG, 'utf-8');
      fs.writeFileSync(
        path.join(iconDir, 'metadata.json'),
        JSON.stringify({
          slug: 'tampered-slug',
          display_name: 'Real Brand',
          brand_color: '#FF0000',
          created_at: new Date().toISOString(),
          pipeline_version: '1.0.0',
          has_black_variant: false,
        }),
        'utf-8',
      );

      const result = (await callTool('list_icons', {})) as {
        icons: Array<{ slug: string; display_name: string }>;
      };

      expect(result.icons).toHaveLength(1);
      // Authoritative slug comes from directory name, not metadata.json
      expect(result.icons[0].slug).toBe('real-slug');
      // display_name from metadata.json is still used (only slug is overridden)
      expect(result.icons[0].display_name).toBe('Real Brand');
    });

    it('should use fallback values when metadata.json fails Zod validation', async () => {
      // brand_color is 123 (number) instead of a string — Zod schema requires string
      const iconDir = path.join(testIconsDir, 'zod-fail-icon');
      fs.mkdirSync(iconDir, { recursive: true });
      fs.writeFileSync(path.join(iconDir, 'icon.svg'), MINIMAL_SVG, 'utf-8');
      fs.writeFileSync(
        path.join(iconDir, 'metadata.json'),
        JSON.stringify({
          slug: 'zod-fail-icon',
          display_name: 'Zod Fail',
          brand_color: 123,  // invalid: number instead of string
          created_at: new Date().toISOString(),
          pipeline_version: '1.0.0',
          has_black_variant: false,
        }),
        'utf-8',
      );

      const result = (await callTool('list_icons', {})) as {
        icons: Array<{ slug: string; display_name: string; brand_color: string; has_black_variant: boolean }>;
      };

      expect(result.icons).toHaveLength(1);
      // Fallback: slug from directory name
      expect(result.icons[0].slug).toBe('zod-fail-icon');
      // Fallback: display_name from slug
      expect(result.icons[0].display_name).toBe('zod-fail-icon');
      // Fallback: default brand_color
      expect(result.icons[0].brand_color).toBe('#000000');
      // Fallback: filesystem check for black variant
      expect(result.icons[0].has_black_variant).toBe(false);
    });

    it('should detect has_black_variant from filesystem when Zod validation fails', async () => {
      const iconDir = path.join(testIconsDir, 'zod-fail-black');
      fs.mkdirSync(iconDir, { recursive: true });
      fs.writeFileSync(path.join(iconDir, 'icon.svg'), MINIMAL_SVG, 'utf-8');
      fs.writeFileSync(path.join(iconDir, 'icon-black.svg'), BLACK_SVG, 'utf-8');
      // brand_color is a number — Zod rejects this
      fs.writeFileSync(
        path.join(iconDir, 'metadata.json'),
        JSON.stringify({
          slug: 'zod-fail-black',
          display_name: 'Zod Fail Black',
          brand_color: 456,
          created_at: new Date().toISOString(),
          pipeline_version: '1.0.0',
          has_black_variant: true,
        }),
        'utf-8',
      );

      const result = (await callTool('list_icons', {})) as {
        icons: Array<{ slug: string; has_black_variant: boolean }>;
      };

      expect(result.icons[0].slug).toBe('zod-fail-black');
      // Fallback path uses filesystem check, not the (invalid) metadata value
      expect(result.icons[0].has_black_variant).toBe(true);
    });
  });

  // ============================================================================
  // Test: delete_icon — slug validation (Zod schema enforcement)
  // ============================================================================

  describe('delete_icon slug validation', () => {
    beforeEach(setupIconsDir);
    afterEach(teardownIconsDir);

    it('should reject invalid slug with uppercase letters', async () => {
      let threw = false;
      let result: unknown;
      try {
        result = await callTool('delete_icon', { slug: 'BadSlug' });
      } catch {
        threw = true;
      }
      if (!threw) {
        expect((result as { error?: string }).error).toBeDefined();
      }
    });

    it('should reject slug starting with a hyphen', async () => {
      let threw = false;
      let result: unknown;
      try {
        result = await callTool('delete_icon', { slug: '-bad' });
      } catch {
        threw = true;
      }
      if (!threw) {
        expect((result as { error?: string }).error).toBeDefined();
      }
    });

    it('should reject slug with trailing hyphen', async () => {
      let threw = false;
      let result: unknown;
      try {
        result = await callTool('delete_icon', { slug: 'brand-' });
      } catch {
        threw = true;
      }
      if (!threw) {
        expect((result as { error?: string }).error).toBeDefined();
      }
    });

    it('should reject slug with consecutive hyphens', async () => {
      let threw = false;
      let result: unknown;
      try {
        result = await callTool('delete_icon', { slug: 'brand--name' });
      } catch {
        threw = true;
      }
      if (!threw) {
        expect((result as { error?: string }).error).toBeDefined();
      }
    });
  });

  // ============================================================================
  // Test: recolor_svg
  // ============================================================================

  describe('recolor_svg', () => {
    it('should apply a new color to a simple SVG', async () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M0 0h64v64H0z" fill="#FFFFFF"/></svg>';

      const result = (await callTool('recolor_svg', {
        svg_content: svg,
        color: '#FF0000',
      })) as { success: boolean; svg_content: string; color_applied: string };

      expect(result.success).toBe(true);
      expect(result.color_applied).toBe('#FF0000');
      expect(result.svg_content).toContain('fill="#FF0000"');
    });

    it('should set fill on root <svg> element', async () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M0 0h64v64H0z"/></svg>';

      const result = (await callTool('recolor_svg', {
        svg_content: svg,
        color: '#0000FF',
      })) as { success: boolean; svg_content: string };

      expect(result.success).toBe(true);
      // The root <svg> tag should have the fill attribute
      expect(result.svg_content).toMatch(/<svg[^>]*fill="#0000FF"/);
    });

    it('should preserve fill="none" on child elements', async () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
        <path d="M0 0h64v64H0z" fill="#FFFFFF"/>
        <path d="M10 10h44v44H10z" fill="none" stroke="black"/>
      </svg>`;

      const result = (await callTool('recolor_svg', {
        svg_content: svg,
        color: '#123456',
      })) as { success: boolean; svg_content: string };

      expect(result.success).toBe(true);
      // fill="none" must be preserved
      expect(result.svg_content).toContain('fill="none"');
    });

    it('should remove explicit fills from child elements so they inherit', async () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
        <path d="M0 0h64v64H0z" fill="#AABBCC"/>
        <path d="M10 10h44v44H10z" fill="#112233"/>
      </svg>`;

      const result = (await callTool('recolor_svg', {
        svg_content: svg,
        color: '#654321',
      })) as { success: boolean; svg_content: string };

      expect(result.success).toBe(true);
      // Original child fills should be gone (so they inherit from root)
      expect(result.svg_content).not.toContain('fill="#AABBCC"');
      expect(result.svg_content).not.toContain('fill="#112233"');
    });

    it('should return error for invalid hex color', async () => {
      const svg = MINIMAL_SVG;

      const result = (await callTool('recolor_svg', {
        svg_content: svg,
        color: 'notacolor',
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid hex color');
    });

    it('should return error when SVG has no <svg> element', async () => {
      const result = (await callTool('recolor_svg', {
        svg_content: '<not-an-svg><path d="M0 0h10z"/></not-an-svg>',
        color: '#000000',
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain('No <svg> element found');
    });

    it('should replace existing fill on root <svg> element', async () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" fill="#AAAAAA" viewBox="0 0 64 64"><path d="M0 0h64v64H0z"/></svg>';

      const result = (await callTool('recolor_svg', {
        svg_content: svg,
        color: '#BBBBBB',
      })) as { success: boolean; svg_content: string };

      expect(result.success).toBe(true);
      // Old color gone, new color present on svg element
      expect(result.svg_content).not.toContain('fill="#AAAAAA"');
      expect(result.svg_content).toContain('fill="#BBBBBB"');
    });

    it('should write output file when output_path is provided', async () => {
      const outputPath = tmpPath('.svg');

      const result = (await callTool('recolor_svg', {
        svg_content: MINIMAL_SVG,
        color: '#FF00FF',
        output_path: outputPath,
      })) as { success: boolean; output_path: string };

      expect(result.success).toBe(true);
      expect(result.output_path).toBe(outputPath);
      expect(fs.existsSync(outputPath)).toBe(true);

      const content = fs.readFileSync(outputPath, 'utf-8');
      expect(content).toContain('#FF00FF');

      fs.unlinkSync(outputPath);
    });

    it('should not set output_path when omitted', async () => {
      const result = (await callTool('recolor_svg', {
        svg_content: MINIMAL_SVG,
        color: '#ABCDEF',
      })) as { success: boolean; output_path?: string };

      expect(result.success).toBe(true);
      expect(result.output_path).toBeUndefined();
    });

    it('should reject path traversal in output_path', async () => {
      const result = (await callTool('recolor_svg', {
        svg_content: MINIMAL_SVG,
        color: '#000000',
        output_path: '/tmp/../../etc/evil.svg',
      })) as { error?: string };

      expect(result.error).toMatch(/Path traversal detected/);
    });

    it('should accept 3-digit hex color', async () => {
      const result = (await callTool('recolor_svg', {
        svg_content: MINIMAL_SVG,
        color: '#FFF',
      })) as { success: boolean; color_applied: string };

      expect(result.success).toBe(true);
      expect(result.color_applied).toBe('#FFF');
    });
  });

  // ============================================================================
  // Test: list_icons + store_icon + delete_icon — round-trip integration
  // ============================================================================

  describe('store/list/delete round-trip', () => {
    beforeEach(setupIconsDir);
    afterEach(teardownIconsDir);

    it('should list then delete then list shows empty', async () => {
      await callTool('store_icon', {
        slug: 'roundtrip',
        display_name: 'Round Trip',
        brand_color: '#ABCDEF',
        svg_content: MINIMAL_SVG,
      });

      const before = (await callTool('list_icons', {})) as { icons: Array<{ slug: string }> };
      expect(before.icons.map((i) => i.slug)).toContain('roundtrip');

      const del = (await callTool('delete_icon', { slug: 'roundtrip' })) as { success: boolean };
      expect(del.success).toBe(true);

      const after = (await callTool('list_icons', {})) as { icons: Array<{ slug: string }> };
      expect(after.icons.map((i) => i.slug)).not.toContain('roundtrip');
    });

    it('should store all 4 variants, list them, delete, then list shows gone', async () => {
      // Store with all 4 variants
      const storeResult = (await callTool('store_icon', {
        slug: 'fullroundtrip',
        display_name: 'Full Round Trip',
        brand_color: '#65A637',
        svg_content: MINIMAL_SVG,
        black_variant_svg: BLACK_SVG,
        white_variant_svg: WHITE_SVG,
        full_color_svg: FULL_COLOR_SVG,
      })) as { success: boolean };
      expect(storeResult.success).toBe(true);

      // List: verify all variant flags are true
      const beforeDelete = (await callTool('list_icons', {})) as {
        icons: Array<{
          slug: string;
          has_black_variant: boolean;
          has_white_variant: boolean;
          has_full_color_variant: boolean;
        }>;
      };
      const stored = beforeDelete.icons.find((i) => i.slug === 'fullroundtrip');
      expect(stored).toBeDefined();
      expect(stored!.has_black_variant).toBe(true);
      expect(stored!.has_white_variant).toBe(true);
      expect(stored!.has_full_color_variant).toBe(true);

      // Delete
      const delResult = (await callTool('delete_icon', { slug: 'fullroundtrip' })) as { success: boolean };
      expect(delResult.success).toBe(true);

      // List: verify gone
      const afterDelete = (await callTool('list_icons', {})) as { icons: Array<{ slug: string }> };
      expect(afterDelete.icons.map((i) => i.slug)).not.toContain('fullroundtrip');
    });

    it('should support multiple icons with mixed metadata states', async () => {
      // Icon with full metadata
      await callTool('store_icon', {
        slug: 'alpha',
        display_name: 'Alpha',
        brand_color: '#AAAAAA',
        svg_content: MINIMAL_SVG,
        source: 'test',
      });

      // Icon with no metadata (bare directory)
      const bareDir = path.join(testIconsDir, 'zeta');
      fs.mkdirSync(bareDir, { recursive: true });
      fs.writeFileSync(path.join(bareDir, 'icon.svg'), MINIMAL_SVG, 'utf-8');

      const result = (await callTool('list_icons', {})) as {
        icons: Array<{ slug: string; display_name: string }>;
      };

      // Sorted alphabetically
      expect(result.icons[0].slug).toBe('alpha');
      expect(result.icons[1].slug).toBe('zeta');
      // zeta fallback uses slug as display_name
      expect(result.icons[1].display_name).toBe('zeta');
    });
  });

  // ============================================================================
  // Test: recolorSvg named export
  // ============================================================================

  describe('recolorSvg named export', () => {
    it('should be exported as a named function from server.ts', async () => {
      const mod = await import('../server.js');
      expect(typeof mod.recolorSvg).toBe('function');
    });

    it('should return a RecolorSvgResult-shaped object when called directly', async () => {
      const mod = await import('../server.js');
      const result = await mod.recolorSvg({
        svg_content: MINIMAL_SVG,
        color: '#123456',
      });

      expect(typeof result.success).toBe('boolean');
      expect(result.success).toBe(true);
      expect(typeof result.svg_content).toBe('string');
      expect(typeof result.color_applied).toBe('string');
      expect(result.color_applied).toBe('#123456');
      expect(result.output_path).toBeUndefined();
    });
  });

  describe('analyze_svg_structure', () => {
    it('should identify paths, text, and groups in an SVG', async () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <g id="icon-group">
          <path d="M 10 10 L 90 10 L 90 90 L 10 90 Z" fill="#333"/>
          <path d="M 20 20 L 80 20 L 80 80 L 20 80 Z" fill="none" stroke="red"/>
        </g>
        <text x="10" y="95" fill="black">Brand Name</text>
      </svg>`;

      const result = (await callTool('analyze_svg_structure', {
        svg_content: svg,
      })) as {
        viewBox: string;
        path_count: number;
        text_count: number;
        group_count: number;
        has_text_elements: boolean;
        shapes: Array<{ tag: string; fill?: string; text_content?: string }>;
      };

      expect(result.viewBox).toBe('0 0 100 100');
      expect(result.path_count).toBe(2);
      expect(result.text_count).toBe(1);
      expect(result.group_count).toBe(1);
      expect(result.has_text_elements).toBe(true);

      // Check that text content was extracted
      const textShape = result.shapes.find((s) => s.tag === 'text');
      expect(textShape?.text_content).toBe('Brand Name');

      // Check path attributes
      const pathShapes = result.shapes.filter((s) => s.tag === 'path');
      expect(pathShapes[0].fill).toBe('#333');
      expect(pathShapes[1].fill).toBe('none');
    });

    it('should compute bounding boxes for paths', async () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <path d="M 10 20 L 80 20 L 80 70 L 10 70 Z" fill="black"/>
      </svg>`;

      const result = (await callTool('analyze_svg_structure', {
        svg_content: svg,
      })) as {
        overall_bbox: { x: number; y: number; width: number; height: number };
        shapes: Array<{ bbox?: { x: number; y: number; width: number; height: number } }>;
      };

      expect(result.overall_bbox).toBeDefined();
      expect(result.overall_bbox!.x).toBeCloseTo(10, 0);
      expect(result.overall_bbox!.y).toBeCloseTo(20, 0);
      expect(result.overall_bbox!.width).toBeCloseTo(70, 0);
      expect(result.overall_bbox!.height).toBeCloseTo(50, 0);
    });
  });

  // ============================================================================
  // Test: setIconsDir guard
  // ============================================================================

  describe('setIconsDir environment guard', () => {
    it('should throw when NODE_ENV is not test and VITEST is not set', () => {
      const origNodeEnv = process.env.NODE_ENV;
      const origVitest = process.env.VITEST;
      try {
        process.env.NODE_ENV = 'production';
        delete process.env.VITEST;
        expect(() => setIconsDir('/tmp/test')).toThrow('setIconsDir is only available in test environments');
      } finally {
        process.env.NODE_ENV = origNodeEnv;
        if (origVitest !== undefined) {
          process.env.VITEST = origVitest;
        }
      }
    });
  });

  // ============================================================================
  // Test: assertContainedIn — symlink escape prevention
  // ============================================================================

  describe('security: symlink escape prevention', () => {
    beforeEach(setupIconsDir);
    afterEach(teardownIconsDir);

    it('should reject delete_icon when slug is a symlink pointing outside ICONS_DIR', () => {
      // Create a symlink inside the icons dir pointing to /tmp (outside)
      const outsideDir = tmpDir();
      const symlinkPath = path.join(testIconsDir, 'evil-link');
      fs.symlinkSync(outsideDir, symlinkPath);

      // delete_icon should reject because the resolved path escapes ICONS_DIR
      return callTool('delete_icon', { slug: 'evil-link' }).then((result) => {
        const r = result as { success: boolean; error?: string };
        // Should fail with containment error (thrown as a tool error)
        expect(r.error || '').toMatch(/Path escapes expected directory/);
        // The outside directory must still exist (not deleted)
        expect(fs.existsSync(outsideDir)).toBe(true);
        fs.rmSync(outsideDir, { recursive: true, force: true });
      });
    });

    it('should allow store_icon with a valid slug (no symlink escape)', async () => {
      const result = (await callTool('store_icon', {
        slug: 'legit-icon',
        display_name: 'Legit',
        brand_color: '#FF0000',
        svg_content: MINIMAL_SVG,
      })) as { success: boolean };

      expect(result.success).toBe(true);
    });
  });
});
