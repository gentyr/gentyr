/**
 * Types for the Icon Processor MCP Server
 *
 * Provides tools for downloading, analyzing, and processing brand/vendor
 * icons into proper square SVG format. Handles background removal,
 * PNG→SVG tracing, SVG normalization, and Simple Icons lookup.
 */

import { z } from 'zod';

// ============================================================================
// Zod Schemas (G003 Compliance)
// ============================================================================

export const LookupSimpleIconSchema = z.object({
  brand_name: z.string().min(1).describe('Brand name to look up (e.g., "GitHub", "Stripe", "Splunk")'),
});

export const DownloadImageSchema = z.object({
  url: z.string().url().describe('URL of the image to download (must be http:// or https://)'),
  output_path: z.string().min(1).describe('Absolute path to save the downloaded file'),
});

export const AnalyzeImageSchema = z.object({
  input_path: z.string().min(1).describe('Absolute path to the image file to analyze'),
});

export const RemoveBackgroundSchema = z.object({
  input_path: z.string().min(1).describe('Absolute path to the input PNG/WEBP image'),
  output_path: z.string().min(1).describe('Absolute path for the output PNG with transparent background'),
  threshold: z.coerce.number().min(0).max(255).default(30).optional()
    .describe('Color distance threshold for background detection (0-255, default 30)'),
});

export const TraceToSvgSchema = z.object({
  input_path: z.string().min(1).describe('Absolute path to the input PNG image (ideally with transparent background)'),
  output_path: z.string().min(1).describe('Absolute path for the output SVG file'),
  color: z.string().optional().describe('Hex color for the traced SVG (e.g., "#000000"). Omit for auto-detect from image.'),
  threshold: z.coerce.number().min(0).max(255).default(128).optional()
    .describe('Luminance threshold for black/white conversion (0-255, default 128)'),
});

export const NormalizeSvgSchema = z.object({
  svg_content: z.string().min(1).describe('Raw SVG content string to normalize'),
  output_path: z.string().min(1).describe('Absolute path for the output normalized SVG file'),
  target_size: z.coerce.number().min(16).max(1024).default(64).optional()
    .describe('Target viewBox dimension (square, default 64)'),
  padding_percent: z.coerce.number().min(0).max(50).default(5).optional()
    .describe('Padding as percentage of viewBox (0-50, default 5%)'),
});

export const OptimizeSvgSchema = z.object({
  svg_content: z.string().min(1).describe('SVG content string to optimize'),
  output_path: z.string().optional().describe('If provided, write optimized SVG to this path'),
});

export const AnalyzeSvgStructureSchema = z.object({
  svg_content: z.string().min(1).describe('SVG content string to analyze'),
});

export const RecolorSvgSchema = z.object({
  svg_content: z.string().min(1).describe('SVG content string to recolor'),
  color: z.string().min(1).describe('Target hex color (e.g., "#65A637")'),
  output_path: z.string().optional().describe('If provided, write recolored SVG to this path'),
});

export const ListIconsSchema = z.object({});

export const StoreIconSchema = z.object({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Slug must be lowercase alphanumeric with hyphens, starting with alphanumeric')
    .describe('Brand slug (e.g. "splunk") — used as the directory name in the global icon store'),
  display_name: z.string().min(1).describe('Human-readable brand name (e.g. "Splunk")'),
  brand_color: z
    .string()
    .min(1)
    .regex(/^#[0-9a-fA-F]{3,8}$/, 'brand_color must be a valid hex color (e.g. "#65A637")')
    .describe('Brand hex color (e.g. "#65A637")'),
  svg_content: z.string().min(1).describe('Final SVG content for the brand-colored icon'),
  source: z.string().optional().describe('Where the icon came from (e.g. "simple-icons", "brand website")'),
  black_variant_svg: z.string().optional().describe('Black (#000000) variant SVG content'),
});

export const DeleteIconSchema = z.object({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Slug must be lowercase alphanumeric with hyphens, starting with alphanumeric')
    .describe('Brand slug to delete from the global icon store'),
});

// ============================================================================
// Inferred Types
// ============================================================================

export type LookupSimpleIconArgs = z.infer<typeof LookupSimpleIconSchema>;
export type DownloadImageArgs = z.infer<typeof DownloadImageSchema>;
export type AnalyzeImageArgs = z.infer<typeof AnalyzeImageSchema>;
export type RemoveBackgroundArgs = z.infer<typeof RemoveBackgroundSchema>;
export type TraceToSvgArgs = z.infer<typeof TraceToSvgSchema>;
export type NormalizeSvgArgs = z.infer<typeof NormalizeSvgSchema>;
export type OptimizeSvgArgs = z.infer<typeof OptimizeSvgSchema>;
export type AnalyzeSvgStructureArgs = z.infer<typeof AnalyzeSvgStructureSchema>;
export type RecolorSvgArgs = z.infer<typeof RecolorSvgSchema>;
export type ListIconsArgs = z.infer<typeof ListIconsSchema>;
export type StoreIconArgs = z.infer<typeof StoreIconSchema>;
export type DeleteIconArgs = z.infer<typeof DeleteIconSchema>;

// ============================================================================
// Result Types
// ============================================================================

export interface LookupSimpleIconResult {
  found: boolean;
  slug?: string;
  title?: string;
  hex_color?: string;
  svg_content?: string;
  suggestions?: string[];
}

export interface DownloadImageResult {
  success: boolean;
  path: string;
  format: string;
  width?: number;
  height?: number;
  size_bytes: number;
  has_alpha?: boolean;
  error?: string;
}

export interface DominantColor {
  r: number;
  g: number;
  b: number;
  hex: string;
}

export interface AnalyzeImageResult {
  width: number;
  height: number;
  format: string;
  channels: number;
  has_alpha: boolean;
  is_opaque: boolean;
  dominant_colors: DominantColor[];
  estimated_background: 'transparent' | 'solid' | 'complex';
  background_color?: DominantColor;
  error?: string;
}

export interface RemoveBackgroundResult {
  success: boolean;
  output_path: string;
  pixels_removed_percentage: number;
  error?: string;
}

export interface TraceToSvgResult {
  success: boolean;
  output_path: string;
  svg_content: string;
  path_count: number;
  error?: string;
}

export interface SvgShapeInfo {
  tag: string;
  id?: string;
  fill?: string;
  stroke?: string;
  opacity?: string;
  bbox?: { x: number; y: number; width: number; height: number };
  path_data?: string;
  text_content?: string;
  child_count?: number;
}

export interface AnalyzeSvgStructureResult {
  viewBox?: string;
  width?: string;
  height?: string;
  element_count: number;
  path_count: number;
  text_count: number;
  group_count: number;
  has_text_elements: boolean;
  shapes: SvgShapeInfo[];
  overall_bbox?: { x: number; y: number; width: number; height: number };
  error?: string;
}

export interface NormalizeSvgResult {
  success: boolean;
  output_path: string;
  svg_content: string;
  original_bbox: { x: number; y: number; width: number; height: number };
  final_viewBox: string;
  element_count: number;
  error?: string;
}

export interface OptimizeSvgResult {
  success: boolean;
  svg_content: string;
  original_bytes: number;
  optimized_bytes: number;
  reduction_percent: number;
  output_path?: string;
  error?: string;
}

export interface RecolorSvgResult {
  success: boolean;
  svg_content: string;
  color_applied: string;
  output_path?: string;
  error?: string;
}

export interface StoredIconEntry {
  slug: string;
  display_name: string;
  brand_color: string;
  source?: string;
  created_at: string;
  has_black_variant: boolean;
}

export interface ListIconsResult {
  icons: StoredIconEntry[];
}

export interface StoreIconResult {
  success: boolean;
  slug: string;
  path: string;
  error?: string;
}

export interface DeleteIconResult {
  success: boolean;
  slug: string;
  error?: string;
}
