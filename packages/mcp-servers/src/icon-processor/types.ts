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
