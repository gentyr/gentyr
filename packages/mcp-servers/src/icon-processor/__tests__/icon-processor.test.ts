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
      const result = (await callTool('download_image', {
        url: 'http://localhost:1/nonexistent-image.png',
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
      const result = (await callTool('download_image', {
        url: 'http://localhost:1/test.png',
        output_path: '/tmp/safe/../../../etc/evil.png',
      })) as { error: string };

      expect(result.error).toMatch(/Path traversal detected/);
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

    it('should return icons sorted alphabetically by slug', async () => {
      await callTool('store_icon', { slug: 'zeta', display_name: 'Zeta', brand_color: '#000', svg_content: MINIMAL_SVG });
      await callTool('store_icon', { slug: 'alpha', display_name: 'Alpha', brand_color: '#000', svg_content: MINIMAL_SVG });
      await callTool('store_icon', { slug: 'mid', display_name: 'Mid', brand_color: '#000', svg_content: MINIMAL_SVG });

      const result = (await callTool('list_icons', {})) as { icons: Array<{ slug: string }> };
      expect(result.icons.map((i) => i.slug)).toEqual(['alpha', 'mid', 'zeta']);
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
      expect(meta.pipeline_version).toBe('1.0.0');
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
});
