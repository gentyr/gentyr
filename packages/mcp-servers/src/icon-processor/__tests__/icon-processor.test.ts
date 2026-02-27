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
import { server } from '../server.js';
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

describe('icon-processor MCP server', () => {
  describe('tools/list', () => {
    it('should list all 8 tools', async () => {
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
        'download_image',
        'lookup_simple_icon',
        'normalize_svg',
        'optimize_svg',
        'remove_background',
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
      })) as { width: number; height: number; estimated_background: string };

      expect(result.width).toBe(64);
      expect(result.height).toBe(64);
      // With a circle in the middle, corners are white = solid background
      expect(result.estimated_background).toBe('solid');

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
