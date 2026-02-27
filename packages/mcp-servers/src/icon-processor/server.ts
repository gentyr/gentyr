#!/usr/bin/env node
/**
 * Icon Processor MCP Server
 *
 * Provides tools for downloading, analyzing, and processing brand/vendor
 * icons into proper square SVG format. Handles background removal,
 * PNG→SVG tracing, SVG normalization, optimization, and Simple Icons lookup.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * @version 1.1.0
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { McpServer } from '../shared/server.js';
import type { AnyToolHandler } from '../shared/server.js';
import {
  LookupSimpleIconSchema,
  DownloadImageSchema,
  AnalyzeImageSchema,
  RemoveBackgroundSchema,
  TraceToSvgSchema,
  NormalizeSvgSchema,
  OptimizeSvgSchema,
  AnalyzeSvgStructureSchema,
  RecolorSvgSchema,
  ListIconsSchema,
  StoreIconSchema,
  DeleteIconSchema,
  type LookupSimpleIconArgs,
  type LookupSimpleIconResult,
  type DownloadImageArgs,
  type DownloadImageResult,
  type AnalyzeImageArgs,
  type AnalyzeImageResult,
  type DominantColor,
  type RemoveBackgroundArgs,
  type RemoveBackgroundResult,
  type TraceToSvgArgs,
  type TraceToSvgResult,
  type NormalizeSvgArgs,
  type NormalizeSvgResult,
  type OptimizeSvgArgs,
  type OptimizeSvgResult,
  type AnalyzeSvgStructureArgs,
  type AnalyzeSvgStructureResult,
  type SvgShapeInfo,
  type RecolorSvgArgs,
  type RecolorSvgResult,
  type ListIconsArgs,
  type ListIconsResult,
  type StoredIconEntry,
  type StoreIconArgs,
  type StoreIconResult,
  type DeleteIconArgs,
  type DeleteIconResult,
} from './types.js';

// ============================================================================
// Lazy-loaded dependencies (avoid loading ~30MB simple-icons at startup)
// ============================================================================

let _sharp: typeof import('sharp') | null = null;
async function getSharp() {
  if (!_sharp) {
    _sharp = (await import('sharp')).default as unknown as typeof import('sharp');
  }
  return _sharp;
}

let _simpleIcons: typeof import('simple-icons') | null = null;
async function getSimpleIcons() {
  if (!_simpleIcons) {
    _simpleIcons = await import('simple-icons');
  }
  return _simpleIcons;
}

let _potrace: typeof import('potrace') | null = null;
async function getPotrace() {
  if (!_potrace) {
    _potrace = await import('potrace');
  }
  return _potrace;
}

let _svgo: typeof import('svgo') | null = null;
async function getSvgo() {
  if (!_svgo) {
    _svgo = await import('svgo');
  }
  return _svgo;
}

let _svgPathBbox: typeof import('svg-path-bbox') | null = null;
async function getSvgPathBbox() {
  if (!_svgPathBbox) {
    _svgPathBbox = await import('svg-path-bbox');
  }
  return _svgPathBbox;
}

// ============================================================================
// Global Icon Store
// ============================================================================

/**
 * Root directory for the global icon store.
 * Exported so tests can override via reassignment before calling tool functions.
 */
export let ICONS_DIR = path.join(os.homedir(), '.claude', 'icons');

/**
 * Override the icons directory (for testing only).
 */
export function setIconsDir(dir: string): void {
  ICONS_DIR = dir;
}

/** Zod schema for metadata.json validation (G003 compliance) */
const IconMetadataSchema = z.object({
  slug: z.string().min(1),
  display_name: z.string().min(1),
  brand_color: z.string().min(1),
  source: z.string().optional(),
  created_at: z.string(),
  pipeline_version: z.string(),
  has_black_variant: z.boolean(),
  has_white_variant: z.boolean().default(false),
  has_full_color_variant: z.boolean().default(false),
  has_artifacts: z.boolean().default(false),
  has_report: z.boolean().default(false),
});
type IconMetadata = z.infer<typeof IconMetadataSchema>;

// ============================================================================
// Security + Utility Helpers
// ============================================================================

/** Max download size: 50 MB */
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
/** Download timeout: 30 seconds */
const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Validate a URL is http:// or https:// only (block file://, ftp://, data:, etc.)
 */
function assertSafeUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked URL protocol: ${parsed.protocol} — only http:// and https:// are allowed`);
  }
}

/**
 * Validate that a file path is absolute and does not contain path traversal sequences.
 * Rejects relative paths and any path containing '..' segments.
 */
function assertSafePath(filePath: string): void {
  // Must be absolute
  if (!path.isAbsolute(filePath)) {
    throw new Error(`Path must be absolute: ${filePath}`);
  }
  // Block path traversal: if normalizing changes the path, it contained .. segments
  if (path.normalize(filePath) !== filePath) {
    throw new Error(`Path traversal detected: ${filePath}`);
  }
}

/** Shared SVGO plugin list for normalization and optimization */
const SVGO_PLUGINS = [
  'removeDoctype',
  'removeXMLProcInst',
  'removeComments',
  'removeMetadata',
  'removeEditorsNSData',
  'cleanupAttrs',
  'mergeStyles',
  'minifyStyles',
  'cleanupIds',
  'removeUselessDefs',
  'cleanupNumericValues',
  'convertColors',
  'removeUnknownsAndDefaults',
  'removeNonInheritableGroupAttrs',
  'removeUselessStrokeAndFill',
  'cleanupEnableBackground',
  'convertPathData',
  'convertTransform',
  'removeEmptyAttrs',
  'removeEmptyContainers',
  'removeUnusedNS',
  'sortAttrs',
];

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function colorDistance(c1: { r: number; g: number; b: number }, c2: { r: number; g: number; b: number }): number {
  return Math.sqrt(
    (c1.r - c2.r) ** 2 +
    (c1.g - c2.g) ** 2 +
    (c1.b - c2.b) ** 2
  );
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}

/**
 * Extract all 'd' attributes from <path> elements in an SVG string.
 * Simple regex-based extraction — does not need a full XML parser.
 */
function extractPathData(svgContent: string): string[] {
  const paths: string[] = [];
  const pathRegex = /<path[^>]*\bd\s*=\s*"([^"]+)"/gi;
  let match;
  while ((match = pathRegex.exec(svgContent)) !== null) {
    paths.push(match[1]);
  }
  return paths;
}

/**
 * Extract SVG elements with metadata for structural analysis.
 */
function extractSvgElements(svgContent: string): SvgShapeInfo[] {
  const shapes: SvgShapeInfo[] = [];
  // Match self-closing and opening tags for visual elements
  const elementRegex = /<(path|rect|circle|ellipse|polygon|polyline|line|text|tspan|g|use|image)(\s[^>]*)?\/?>/gi;
  let match;
  while ((match = elementRegex.exec(svgContent)) !== null) {
    const tag = match[1].toLowerCase();
    const attrs = match[2] || '';

    const shape: SvgShapeInfo = { tag };

    // Extract common attributes
    const idMatch = attrs.match(/\bid\s*=\s*"([^"]+)"/);
    if (idMatch) shape.id = idMatch[1];

    const fillMatch = attrs.match(/\bfill\s*=\s*"([^"]+)"/);
    if (fillMatch) shape.fill = fillMatch[1];

    const strokeMatch = attrs.match(/\bstroke\s*=\s*"([^"]+)"/);
    if (strokeMatch) shape.stroke = strokeMatch[1];

    const opacityMatch = attrs.match(/\bopacity\s*=\s*"([^"]+)"/);
    if (opacityMatch) shape.opacity = opacityMatch[1];

    if (tag === 'path') {
      const dMatch = attrs.match(/\bd\s*=\s*"([^"]+)"/);
      if (dMatch) shape.path_data = dMatch[1];
    }

    if (tag === 'text' || tag === 'tspan') {
      // Try to extract text content between tags
      const closeTag = `</${tag}>`;
      const startIdx = match.index + match[0].length;
      const endIdx = svgContent.indexOf(closeTag, startIdx);
      if (endIdx > startIdx) {
        shape.text_content = svgContent.slice(startIdx, endIdx).replace(/<[^>]+>/g, '').trim();
      }
    }

    shapes.push(shape);
  }
  return shapes;
}


// ============================================================================
// Tool Implementations
// ============================================================================

async function lookupSimpleIcon(args: LookupSimpleIconArgs): Promise<LookupSimpleIconResult> {
  const si = await getSimpleIcons();

  // simple-icons exports icons as siXxx where Xxx is the PascalCase slug
  // But it also has a helper to search by title
  const allIcons = Object.values(si) as Array<{
    title: string;
    slug: string;
    hex: string;
    svg: string;
    path: string;
  }>;

  // Filter out non-icon exports (functions, constants, etc.)
  const icons = allIcons.filter(
    (icon) => icon && typeof icon === 'object' && 'slug' in icon && 'svg' in icon
  );

  // Exact match (case-insensitive)
  const searchLower = args.brand_name.toLowerCase();
  const exact = icons.find(
    (icon) => icon.title.toLowerCase() === searchLower || icon.slug === searchLower
  );

  if (exact) {
    return {
      found: true,
      slug: exact.slug,
      title: exact.title,
      hex_color: `#${exact.hex}`,
      svg_content: exact.svg,
    };
  }

  // Fuzzy match: find close matches for suggestions
  const suggestions = icons
    .filter((icon) => {
      const titleLower = icon.title.toLowerCase();
      const slugLower = icon.slug.toLowerCase();
      return titleLower.includes(searchLower) || slugLower.includes(searchLower) ||
             searchLower.includes(titleLower) || searchLower.includes(slugLower);
    })
    .slice(0, 5)
    .map((icon) => icon.title);

  return { found: false, suggestions };
}

async function downloadImage(args: DownloadImageArgs): Promise<DownloadImageResult> {
  // Security: validate URL protocol
  try {
    assertSafeUrl(args.url);
  } catch (err) {
    return {
      success: false,
      path: args.output_path,
      format: 'unknown',
      size_bytes: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Security: validate output path
  assertSafePath(args.output_path);
  ensureDir(args.output_path);

  let response: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    response = await fetch(args.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'image/*,*/*',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (err) {
    return {
      success: false,
      path: args.output_path,
      format: 'unknown',
      size_bytes: 0,
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Security: validate final URL after redirects (prevents SSRF via redirect to internal network)
  try {
    assertSafeUrl(response.url);
  } catch (err) {
    return {
      success: false,
      path: args.output_path,
      format: 'unknown',
      size_bytes: 0,
      error: `Redirect target blocked: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!response.ok) {
    return {
      success: false,
      path: args.output_path,
      format: 'unknown',
      size_bytes: 0,
      error: `HTTP ${response.status}: ${response.statusText}`,
    };
  }

  // Security: check Content-Length before downloading body
  const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
  if (contentLength > MAX_DOWNLOAD_BYTES) {
    return {
      success: false,
      path: args.output_path,
      format: 'unknown',
      size_bytes: 0,
      error: `Response too large: ${contentLength} bytes exceeds ${MAX_DOWNLOAD_BYTES} byte limit`,
    };
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  // Security: verify actual body size
  if (buffer.length > MAX_DOWNLOAD_BYTES) {
    return {
      success: false,
      path: args.output_path,
      format: 'unknown',
      size_bytes: buffer.length,
      error: `Downloaded content too large: ${buffer.length} bytes exceeds ${MAX_DOWNLOAD_BYTES} byte limit`,
    };
  }
  fs.writeFileSync(args.output_path, buffer);

  const contentType = response.headers.get('content-type') || '';
  const ext = path.extname(args.output_path).toLowerCase();

  // If it's an SVG, return basic info without sharp
  if (contentType.includes('svg') || ext === '.svg') {
    return {
      success: true,
      path: args.output_path,
      format: 'svg',
      size_bytes: buffer.length,
    };
  }

  // Use sharp for raster image metadata
  try {
    const sharp = await getSharp();
    const metadata = await sharp(buffer).metadata();
    return {
      success: true,
      path: args.output_path,
      format: metadata.format || ext.replace('.', '') || 'unknown',
      width: metadata.width,
      height: metadata.height,
      size_bytes: buffer.length,
      has_alpha: metadata.hasAlpha,
    };
  } catch {
    return {
      success: true,
      path: args.output_path,
      format: ext.replace('.', '') || 'unknown',
      size_bytes: buffer.length,
    };
  }
}

async function analyzeImage(args: AnalyzeImageArgs): Promise<AnalyzeImageResult> {
  assertSafePath(args.input_path);
  if (!fs.existsSync(args.input_path)) {
    return { width: 0, height: 0, format: 'unknown', channels: 0, has_alpha: false, is_opaque: true, dominant_colors: [], estimated_background: 'complex', error: `File not found: ${args.input_path}` };
  }

  const sharp = await getSharp();
  const image = sharp(args.input_path);
  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height) {
    return { width: 0, height: 0, format: metadata.format || 'unknown', channels: metadata.channels || 0, has_alpha: !!metadata.hasAlpha, is_opaque: true, dominant_colors: [], estimated_background: 'complex', error: 'Could not read image dimensions' };
  }

  const stats = await image.stats();

  // Extract dominant colors from channel statistics
  const dominant_colors: DominantColor[] = [];
  if (stats.channels.length >= 3) {
    const r = Math.round(stats.channels[0].mean);
    const g = Math.round(stats.channels[1].mean);
    const b = Math.round(stats.channels[2].mean);
    dominant_colors.push({ r, g, b, hex: rgbToHex(r, g, b) });
  }

  // Sample corner pixels to detect background color
  const { data: rawPixels, info } = await image
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const ch = info.channels;

  function getPixel(x: number, y: number) {
    const offset = (y * w + x) * ch;
    return {
      r: rawPixels[offset],
      g: rawPixels[offset + 1],
      b: rawPixels[offset + 2],
      a: ch >= 4 ? rawPixels[offset + 3] : 255,
    };
  }

  // Sample 4 corners
  const corners = [
    getPixel(0, 0),
    getPixel(w - 1, 0),
    getPixel(0, h - 1),
    getPixel(w - 1, h - 1),
  ];

  // Check if corners are transparent
  const transparentCorners = corners.filter(c => c.a < 10).length;
  if (transparentCorners >= 3) {
    return {
      width: metadata.width, height: metadata.height,
      format: metadata.format || 'unknown', channels: metadata.channels || 0,
      has_alpha: true, is_opaque: false,
      dominant_colors, estimated_background: 'transparent',
    };
  }

  // Check if corners are similar color (solid background)
  const cornerColors = corners.map(c => ({ r: c.r, g: c.g, b: c.b }));
  const refColor = cornerColors[0];
  const allSimilar = cornerColors.every(c => colorDistance(c, refColor) < 40);

  if (allSimilar) {
    const bgColor: DominantColor = {
      r: refColor.r, g: refColor.g, b: refColor.b,
      hex: rgbToHex(refColor.r, refColor.g, refColor.b),
    };
    return {
      width: metadata.width, height: metadata.height,
      format: metadata.format || 'unknown', channels: metadata.channels || 0,
      has_alpha: !!metadata.hasAlpha, is_opaque: !metadata.hasAlpha,
      dominant_colors, estimated_background: 'solid',
      background_color: bgColor,
    };
  }

  return {
    width: metadata.width, height: metadata.height,
    format: metadata.format || 'unknown', channels: metadata.channels || 0,
    has_alpha: !!metadata.hasAlpha, is_opaque: !metadata.hasAlpha,
    dominant_colors, estimated_background: 'complex',
  };
}

async function removeBackground(args: RemoveBackgroundArgs): Promise<RemoveBackgroundResult> {
  assertSafePath(args.input_path);
  assertSafePath(args.output_path);
  if (!fs.existsSync(args.input_path)) {
    return { success: false, output_path: args.output_path, pixels_removed_percentage: 0, error: `File not found: ${args.input_path}` };
  }

  ensureDir(args.output_path);
  const sharp = await getSharp();
  const threshold = args.threshold ?? 30;

  const image = sharp(args.input_path);
  const { data: rawPixels, info } = await image
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const ch = info.channels; // should be 4 with ensureAlpha

  // Detect background color from corners
  function getPixel(x: number, y: number) {
    const offset = (y * w + x) * ch;
    return { r: rawPixels[offset], g: rawPixels[offset + 1], b: rawPixels[offset + 2] };
  }

  const corners = [getPixel(0, 0), getPixel(w - 1, 0), getPixel(0, h - 1), getPixel(w - 1, h - 1)];
  // Use the most common corner color as background
  const bgColor = corners[0]; // simplified: use top-left

  // Create output buffer with alpha channel
  const output = Buffer.from(rawPixels);
  let removedCount = 0;
  const totalPixels = w * h;

  for (let i = 0; i < totalPixels; i++) {
    const offset = i * ch;
    const px = { r: output[offset], g: output[offset + 1], b: output[offset + 2] };
    if (colorDistance(px, bgColor) <= threshold) {
      output[offset + 3] = 0; // make transparent
      removedCount++;
    }
  }

  await sharp(output, { raw: { width: w, height: h, channels: ch } })
    .png()
    .toFile(args.output_path);

  return {
    success: true,
    output_path: args.output_path,
    pixels_removed_percentage: Math.round((removedCount / totalPixels) * 100),
  };
}

async function traceToSvg(args: TraceToSvgArgs): Promise<TraceToSvgResult> {
  assertSafePath(args.input_path);
  assertSafePath(args.output_path);
  if (!fs.existsSync(args.input_path)) {
    return { success: false, output_path: args.output_path, svg_content: '', path_count: 0, error: `File not found: ${args.input_path}` };
  }

  ensureDir(args.output_path);
  const potrace = await getPotrace();

  return new Promise((resolve) => {
    const params: Record<string, unknown> = {};
    if (args.color) params.color = args.color;
    if (args.threshold !== undefined) params.threshold = args.threshold;

    potrace.trace(args.input_path, params, (err: Error | null, svg: string) => {
      if (err) {
        resolve({
          success: false,
          output_path: args.output_path,
          svg_content: '',
          path_count: 0,
          error: err.message,
        });
        return;
      }

      fs.writeFileSync(args.output_path, svg, 'utf-8');
      const pathCount = extractPathData(svg).length;

      resolve({
        success: true,
        output_path: args.output_path,
        svg_content: svg,
        path_count: pathCount,
      });
    });
  });
}

async function analyzeSvgStructure(args: AnalyzeSvgStructureArgs): Promise<AnalyzeSvgStructureResult> {
  const svgContent = args.svg_content;
  const shapes = extractSvgElements(svgContent);
  const svgPathBboxMod = await getSvgPathBbox();
  const svgPathBbox = svgPathBboxMod.svgPathBbox;

  // Extract viewBox
  const viewBoxMatch = svgContent.match(/viewBox\s*=\s*"([^"]+)"/);
  const widthMatch = svgContent.match(/<svg[^>]*\bwidth\s*=\s*"([^"]+)"/);
  const heightMatch = svgContent.match(/<svg[^>]*\bheight\s*=\s*"([^"]+)"/);

  // Count element types
  const pathCount = shapes.filter(s => s.tag === 'path').length;
  const textCount = shapes.filter(s => s.tag === 'text' || s.tag === 'tspan').length;
  const groupCount = shapes.filter(s => s.tag === 'g').length;

  // Compute bounding boxes for path elements
  let overallMinX = Infinity, overallMinY = Infinity;
  let overallMaxX = -Infinity, overallMaxY = -Infinity;

  for (const shape of shapes) {
    if (shape.tag === 'path' && shape.path_data) {
      try {
        const [minX, minY, maxX, maxY] = svgPathBbox(shape.path_data);
        if (isFinite(minX) && isFinite(minY) && isFinite(maxX) && isFinite(maxY)) {
          shape.bbox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
          overallMinX = Math.min(overallMinX, minX);
          overallMinY = Math.min(overallMinY, minY);
          overallMaxX = Math.max(overallMaxX, maxX);
          overallMaxY = Math.max(overallMaxY, maxY);
        }
      } catch {
        // Skip paths with unparseable data
      }
    }
  }

  const overall_bbox = isFinite(overallMinX) ? {
    x: overallMinX, y: overallMinY,
    width: overallMaxX - overallMinX, height: overallMaxY - overallMinY,
  } : undefined;

  return {
    viewBox: viewBoxMatch?.[1],
    width: widthMatch?.[1],
    height: heightMatch?.[1],
    element_count: shapes.length,
    path_count: pathCount,
    text_count: textCount,
    group_count: groupCount,
    has_text_elements: textCount > 0,
    shapes,
    overall_bbox,
  };
}

async function normalizeSvg(args: NormalizeSvgArgs): Promise<NormalizeSvgResult> {
  assertSafePath(args.output_path);
  const targetSize = args.target_size ?? 64;
  const paddingPercent = args.padding_percent ?? 5;

  ensureDir(args.output_path);
  const svgPathBboxMod = await getSvgPathBbox();
  const svgPathBbox = svgPathBboxMod.svgPathBbox;
  const svgoMod = await getSvgo();

  // Extract all path 'd' data
  const pathDataList = extractPathData(args.svg_content);

  if (pathDataList.length === 0) {
    return {
      success: false, output_path: args.output_path, svg_content: args.svg_content,
      original_bbox: { x: 0, y: 0, width: 0, height: 0 }, final_viewBox: '',
      element_count: 0, error: 'No path elements found in SVG',
    };
  }

  // Compute tight bounding box across all paths
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const d of pathDataList) {
    try {
      const [x1, y1, x2, y2] = svgPathBbox(d);
      if (isFinite(x1) && isFinite(y1) && isFinite(x2) && isFinite(y2)) {
        minX = Math.min(minX, x1);
        minY = Math.min(minY, y1);
        maxX = Math.max(maxX, x2);
        maxY = Math.max(maxY, y2);
      }
    } catch {
      // Skip unparseable paths
    }
  }

  if (!isFinite(minX)) {
    return {
      success: false, output_path: args.output_path, svg_content: args.svg_content,
      original_bbox: { x: 0, y: 0, width: 0, height: 0 }, final_viewBox: '',
      element_count: pathDataList.length, error: 'Could not compute bounding box for any paths',
    };
  }

  const contentWidth = maxX - minX;
  const contentHeight = maxY - minY;
  const originalBbox = { x: minX, y: minY, width: contentWidth, height: contentHeight };

  // Make square: use the larger dimension
  const maxDim = Math.max(contentWidth, contentHeight);
  const padding = maxDim * (paddingPercent / 100);
  const totalSize = maxDim + padding * 2;

  // Center the content in the square viewBox
  const centerX = minX + contentWidth / 2;
  const centerY = minY + contentHeight / 2;
  const viewBoxX = centerX - totalSize / 2;
  const viewBoxY = centerY - totalSize / 2;

  const viewBoxStr = `${viewBoxX.toFixed(2)} ${viewBoxY.toFixed(2)} ${totalSize.toFixed(2)} ${totalSize.toFixed(2)}`;

  // Replace or set viewBox and dimensions in SVG
  let normalizedSvg = args.svg_content;

  // Replace viewBox
  if (/viewBox\s*=\s*"[^"]*"/.test(normalizedSvg)) {
    normalizedSvg = normalizedSvg.replace(/viewBox\s*=\s*"[^"]*"/, `viewBox="${viewBoxStr}"`);
  } else {
    normalizedSvg = normalizedSvg.replace(/<svg/, `<svg viewBox="${viewBoxStr}"`);
  }

  // Set width/height to target size
  if (/\bwidth\s*=\s*"[^"]*"/.test(normalizedSvg.match(/<svg[^>]*>/)?.[0] || '')) {
    normalizedSvg = normalizedSvg.replace(
      /(<svg[^>]*)\bwidth\s*=\s*"[^"]*"/,
      `$1width="${targetSize}"`
    );
  } else {
    normalizedSvg = normalizedSvg.replace(/<svg/, `<svg width="${targetSize}"`);
  }

  if (/\bheight\s*=\s*"[^"]*"/.test(normalizedSvg.match(/<svg[^>]*>/)?.[0] || '')) {
    normalizedSvg = normalizedSvg.replace(
      /(<svg[^>]*)\bheight\s*=\s*"[^"]*"/,
      `$1height="${targetSize}"`
    );
  } else {
    normalizedSvg = normalizedSvg.replace(/<svg/, `<svg height="${targetSize}"`);
  }

  // Optimize with SVGO
  try {
    const optimized = svgoMod.optimize(normalizedSvg, { plugins: [...SVGO_PLUGINS] as any });
    normalizedSvg = optimized.data;
  } catch {
    // SVGO failure is non-fatal, use unoptimized version
  }

  fs.writeFileSync(args.output_path, normalizedSvg, 'utf-8');
  const elementCount = extractSvgElements(normalizedSvg).length;

  return {
    success: true,
    output_path: args.output_path,
    svg_content: normalizedSvg,
    original_bbox: originalBbox,
    final_viewBox: viewBoxStr,
    element_count: elementCount,
  };
}

async function optimizeSvg(args: OptimizeSvgArgs): Promise<OptimizeSvgResult> {
  const svgoMod = await getSvgo();
  const originalBytes = Buffer.byteLength(args.svg_content, 'utf-8');

  try {
    const result = svgoMod.optimize(args.svg_content, {
      plugins: [...SVGO_PLUGINS] as any,
    });

    const optimizedBytes = Buffer.byteLength(result.data, 'utf-8');
    const reduction = originalBytes > 0 ? Math.round((1 - optimizedBytes / originalBytes) * 100) : 0;

    if (args.output_path) {
      assertSafePath(args.output_path);
      ensureDir(args.output_path);
      fs.writeFileSync(args.output_path, result.data, 'utf-8');
    }

    return {
      success: true,
      svg_content: result.data,
      original_bytes: originalBytes,
      optimized_bytes: optimizedBytes,
      reduction_percent: reduction,
      output_path: args.output_path,
    };
  } catch (err) {
    return {
      success: false,
      svg_content: args.svg_content,
      original_bytes: originalBytes,
      optimized_bytes: originalBytes,
      reduction_percent: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function recolorSvg(args: RecolorSvgArgs): Promise<RecolorSvgResult> {
  // Validate hex color format
  if (!/^#[0-9a-fA-F]{3,8}$/.test(args.color)) {
    return { success: false, svg_content: args.svg_content, color_applied: args.color, error: `Invalid hex color: ${args.color}` };
  }

  let svg = args.svg_content;

  // Strategy: set fill on the root <svg> element and remove fill from children so they inherit.
  // 1. Replace or add fill on <svg> tag
  const svgTagMatch = svg.match(/<svg([^>]*)>/);
  if (!svgTagMatch) {
    return { success: false, svg_content: svg, color_applied: args.color, error: 'No <svg> element found' };
  }

  let svgAttrs = svgTagMatch[1];
  if (/\bfill\s*=\s*"[^"]*"/.test(svgAttrs)) {
    svgAttrs = svgAttrs.replace(/\bfill\s*=\s*"[^"]*"/, `fill="${args.color}"`);
  } else {
    svgAttrs = ` fill="${args.color}"` + svgAttrs;
  }
  svg = svg.replace(/<svg[^>]*>/, `<svg${svgAttrs}>`);

  // 2. Remove explicit fill attributes from child elements so they inherit from root
  //    (but preserve "none" fills — those are intentional cutouts)
  svg = svg.replace(/(<(?!svg\b)[^>]*)\bfill="(?!none)[^"]*"/g, '$1');

  // 3. Remove fill from inline styles on child elements
  svg = svg.replace(/(<(?!svg\b)[^>]*style="[^"]*?)fill\s*:\s*(?!none)[^;"]*;?/g, '$1');

  // 4. Remove fill from <g> elements too (they often override inheritance)
  // Already handled by step 2 since it targets all non-svg elements

  if (args.output_path) {
    assertSafePath(args.output_path);
    ensureDir(args.output_path);
    fs.writeFileSync(args.output_path, svg, 'utf-8');
  }

  return { success: true, svg_content: svg, color_applied: args.color, output_path: args.output_path };
}

// ============================================================================
// Global Icon Store Tool Implementations
// ============================================================================

async function listIcons(_args: ListIconsArgs): Promise<ListIconsResult> {
  if (!fs.existsSync(ICONS_DIR)) {
    return { icons: [] };
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(ICONS_DIR, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Failed to read icons directory: ${err instanceof Error ? err.message : String(err)}`);
  }

  const icons: StoredIconEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const slug = entry.name;
    const brandDir = path.join(ICONS_DIR, slug);
    // Use assertSafePath to guard against any malformed slugs that escaped validation
    assertSafePath(brandDir);

    const metadataPath = path.join(brandDir, 'metadata.json');
    if (!fs.existsSync(metadataPath)) {
      // Directory exists but no metadata — include with minimal info
      icons.push({
        slug,
        display_name: slug,
        brand_color: '#000000',
        created_at: '',
        has_black_variant: fs.existsSync(path.join(brandDir, 'icon-black.svg')),
        has_white_variant: fs.existsSync(path.join(brandDir, 'icon-white.svg')),
        has_full_color_variant: fs.existsSync(path.join(brandDir, 'icon-full-color.svg')),
        has_artifacts: fs.existsSync(path.join(brandDir, 'artifacts')),
        has_report: fs.existsSync(path.join(brandDir, 'report.md')),
      });
      continue;
    }

    try {
      const raw = fs.readFileSync(metadataPath, 'utf-8');
      const parsed = IconMetadataSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        const meta = parsed.data;
        // Use directory name as authoritative slug, not metadata's slug field
        // (metadata.json is user-writable and could be tampered with)
        icons.push({
          slug,
          display_name: meta.display_name,
          brand_color: meta.brand_color,
          source: meta.source,
          created_at: meta.created_at,
          has_black_variant: meta.has_black_variant,
          has_white_variant: meta.has_white_variant,
          has_full_color_variant: meta.has_full_color_variant,
          has_artifacts: meta.has_artifacts,
          has_report: meta.has_report,
        });
      } else {
        // Zod validation failed — include with minimal info
        icons.push({
          slug,
          display_name: slug,
          brand_color: '#000000',
          created_at: '',
          has_black_variant: fs.existsSync(path.join(brandDir, 'icon-black.svg')),
          has_white_variant: fs.existsSync(path.join(brandDir, 'icon-white.svg')),
          has_full_color_variant: fs.existsSync(path.join(brandDir, 'icon-full-color.svg')),
          has_artifacts: fs.existsSync(path.join(brandDir, 'artifacts')),
          has_report: fs.existsSync(path.join(brandDir, 'report.md')),
        });
      }
    } catch {
      // Malformed metadata — include with minimal info derived from slug
      icons.push({
        slug,
        display_name: slug,
        brand_color: '#000000',
        created_at: '',
        has_black_variant: fs.existsSync(path.join(brandDir, 'icon-black.svg')),
        has_white_variant: fs.existsSync(path.join(brandDir, 'icon-white.svg')),
        has_full_color_variant: fs.existsSync(path.join(brandDir, 'icon-full-color.svg')),
        has_artifacts: fs.existsSync(path.join(brandDir, 'artifacts')),
        has_report: fs.existsSync(path.join(brandDir, 'report.md')),
      });
    }
  }

  // Sort alphabetically by slug for deterministic output
  icons.sort((a, b) => a.slug.localeCompare(b.slug));
  return { icons };
}

async function storeIcon(args: StoreIconArgs): Promise<StoreIconResult> {
  const brandDir = path.join(ICONS_DIR, args.slug);

  // assertSafePath guards against path traversal — slug validation in Zod schema
  // provides the first layer; this provides defense-in-depth at the FS level.
  assertSafePath(brandDir);

  try {
    fs.mkdirSync(brandDir, { recursive: true });
  } catch (err) {
    return {
      success: false,
      slug: args.slug,
      path: brandDir,
      error: `Failed to create directory: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Clean up stale variant files from a previous store call.
  // If a variant is omitted this time but existed on disk from a prior call,
  // remove it so metadata and filesystem stay consistent.
  const variantFiles = [
    { provided: !!args.black_variant_svg, filename: 'icon-black.svg' },
    { provided: !!args.white_variant_svg, filename: 'icon-white.svg' },
    { provided: !!args.full_color_svg, filename: 'icon-full-color.svg' },
  ];
  for (const { provided, filename } of variantFiles) {
    if (!provided) {
      const variantPath = path.join(brandDir, filename);
      try { fs.unlinkSync(variantPath); } catch { /* file may not exist — ignore */ }
    }
  }

  // Write brand-colored SVG
  const iconPath = path.join(brandDir, 'icon.svg');
  try {
    fs.writeFileSync(iconPath, args.svg_content, 'utf-8');
  } catch (err) {
    return {
      success: false,
      slug: args.slug,
      path: brandDir,
      error: `Failed to write icon.svg: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Write black variant if provided
  const hasBlackVariant = !!args.black_variant_svg;
  if (args.black_variant_svg) {
    const blackIconPath = path.join(brandDir, 'icon-black.svg');
    try {
      fs.writeFileSync(blackIconPath, args.black_variant_svg, 'utf-8');
    } catch (err) {
      return {
        success: false,
        slug: args.slug,
        path: brandDir,
        error: `Failed to write icon-black.svg: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Write white variant if provided
  const hasWhiteVariant = !!args.white_variant_svg;
  if (args.white_variant_svg) {
    const whiteIconPath = path.join(brandDir, 'icon-white.svg');
    try {
      fs.writeFileSync(whiteIconPath, args.white_variant_svg, 'utf-8');
    } catch (err) {
      return {
        success: false,
        slug: args.slug,
        path: brandDir,
        error: `Failed to write icon-white.svg: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Write full-color variant if provided
  const hasFullColorVariant = !!args.full_color_svg;
  if (args.full_color_svg) {
    const fullColorIconPath = path.join(brandDir, 'icon-full-color.svg');
    try {
      fs.writeFileSync(fullColorIconPath, args.full_color_svg, 'utf-8');
    } catch (err) {
      return {
        success: false,
        slug: args.slug,
        path: brandDir,
        error: `Failed to write icon-full-color.svg: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Write report.md if provided
  const hasReport = !!args.report_md;
  if (args.report_md) {
    const reportPath = path.join(brandDir, 'report.md');
    try {
      fs.writeFileSync(reportPath, args.report_md, 'utf-8');
    } catch (err) {
      return {
        success: false,
        slug: args.slug,
        path: brandDir,
        error: `Failed to write report.md: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Detect artifacts directory (written by agent before store_icon is called)
  const hasArtifacts = fs.existsSync(path.join(brandDir, 'artifacts'));

  // Write metadata
  const metadata: IconMetadata = {
    slug: args.slug,
    display_name: args.display_name,
    brand_color: args.brand_color,
    source: args.source,
    created_at: new Date().toISOString(),
    pipeline_version: '1.1.0',
    has_black_variant: hasBlackVariant,
    has_white_variant: hasWhiteVariant,
    has_full_color_variant: hasFullColorVariant,
    has_artifacts: hasArtifacts,
    has_report: hasReport,
  };

  const metadataPath = path.join(brandDir, 'metadata.json');
  try {
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
  } catch (err) {
    return {
      success: false,
      slug: args.slug,
      path: brandDir,
      error: `Failed to write metadata.json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { success: true, slug: args.slug, path: brandDir };
}

async function deleteIcon(args: DeleteIconArgs): Promise<DeleteIconResult> {
  const brandDir = path.join(ICONS_DIR, args.slug);
  assertSafePath(brandDir);

  if (!fs.existsSync(brandDir)) {
    return {
      success: false,
      slug: args.slug,
      error: `Icon not found: no directory at ${brandDir}`,
    };
  }

  try {
    fs.rmSync(brandDir, { recursive: true, force: false });
  } catch (err) {
    return {
      success: false,
      slug: args.slug,
      error: `Failed to delete icon: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { success: true, slug: args.slug };
}

// ============================================================================
// Server Registration
// ============================================================================

const tools: AnyToolHandler[] = [
  {
    name: 'lookup_simple_icon',
    description: 'Look up a brand icon in the Simple Icons database (3000+ brands). Fast path — no network required. Returns the SVG content and brand color if found.',
    schema: LookupSimpleIconSchema,
    handler: lookupSimpleIcon,
  },
  {
    name: 'download_image',
    description: 'Download an image (PNG, SVG, ICO, WEBP) from a URL. Returns file metadata including dimensions and format.',
    schema: DownloadImageSchema,
    handler: downloadImage,
  },
  {
    name: 'analyze_image',
    description: 'Analyze a raster image file. Returns dimensions, color info, alpha channel presence, and background type estimation (transparent/solid/complex). Use this to decide whether background removal is needed.',
    schema: AnalyzeImageSchema,
    handler: analyzeImage,
  },
  {
    name: 'remove_background',
    description: 'Remove a solid-color background from a PNG/WEBP image. Detects the background color from corner pixels and makes matching pixels transparent. Works well for icons on solid white/colored backgrounds.',
    schema: RemoveBackgroundSchema,
    handler: removeBackground,
  },
  {
    name: 'trace_to_svg',
    description: 'Convert a raster image (PNG) to SVG using bitmap tracing (potrace). Best results with high-contrast images on transparent backgrounds. Returns the SVG content and path count.',
    schema: TraceToSvgSchema,
    handler: traceToSvg,
  },
  {
    name: 'normalize_svg',
    description: 'Normalize an SVG to a square viewBox. Computes the tight bounding box of all path elements, centers the content in a square viewBox with configurable padding, sets target dimensions, and optimizes with SVGO.',
    schema: NormalizeSvgSchema,
    handler: normalizeSvg,
  },
  {
    name: 'optimize_svg',
    description: 'Optimize an SVG using SVGO. Removes comments, metadata, editor cruft, and optimizes paths/colors/transforms. Returns the optimized SVG content with size reduction stats.',
    schema: OptimizeSvgSchema,
    handler: optimizeSvg,
  },
  {
    name: 'analyze_svg_structure',
    description: 'Analyze the structure of an SVG. Returns a breakdown of all elements (paths, text, groups, etc.) with their attributes (fill, stroke, opacity), bounding boxes for paths, and whether text elements are present. Use this to understand an SVG before deciding what to keep, remove, or modify.',
    schema: AnalyzeSvgStructureSchema,
    handler: analyzeSvgStructure,
  },
  {
    name: 'recolor_svg',
    description: 'Recolor an SVG to a single target color. Sets fill on the root <svg> element and removes explicit fills from child elements so they inherit. Preserves fill="none" (intentional cutouts). Use this to apply a brand color to a finalized icon.',
    schema: RecolorSvgSchema,
    handler: recolorSvg,
  },
  {
    name: 'list_icons',
    description: 'List all icons stored in the global icon store (~/.claude/icons/). Returns an array of stored icon entries with slug, display_name, brand_color, source, created_at, has_black_variant, has_white_variant, and has_full_color_variant.',
    schema: ListIconsSchema,
    handler: listIcons,
  },
  {
    name: 'store_icon',
    description: 'Store a finalized icon to the global icon store (~/.claude/icons/<slug>/). Creates icon.svg (brand-colored), optionally icon-black.svg, icon-white.svg, and icon-full-color.svg, and metadata.json. Use this at the end of the icon-finder pipeline to persist results globally.',
    schema: StoreIconSchema,
    handler: storeIcon,
  },
  {
    name: 'delete_icon',
    description: 'Delete an icon from the global icon store (~/.claude/icons/<slug>/). Removes the entire brand directory including all SVG files and metadata. Requires CTO approval via the protected-action-gate.',
    schema: DeleteIconSchema,
    handler: deleteIcon,
  },
];

const server = new McpServer({
  name: 'icon-processor',
  version: '1.1.0',
  tools,
});

// Only start when run as CLI entry point (not when imported in tests)
const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('/icon-processor/server.js') ||
  process.argv[1].endsWith('/icon-processor/server.ts')
);
if (isMainModule) {
  server.start();
}

// Export for testing
export { server, tools, lookupSimpleIcon, downloadImage, analyzeImage, removeBackground, traceToSvg, normalizeSvg, optimizeSvg, analyzeSvgStructure, recolorSvg, listIcons, storeIcon, deleteIcon };
