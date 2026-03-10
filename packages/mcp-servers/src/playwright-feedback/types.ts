/**
 * Types for the Playwright Feedback MCP Server
 *
 * Provides Playwright-based browser interaction tools for AI feedback agents
 * testing web applications from a real user's perspective.
 */

import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

export const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
export type ScrollDirection = (typeof SCROLL_DIRECTIONS)[number];

export const ARIA_ROLES = [
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'menuitem',
  'tab',
  'heading',
  'img',
  'region',
  'navigation',
  'main',
  'complementary',
  'contentinfo',
  'banner',
  'search',
  'form',
  'article',
  'section',
  'dialog',
  'alert',
  'status',
] as const;
export type AriaRole = (typeof ARIA_ROLES)[number];

// ============================================================================
// Navigation Schemas (G003 Compliance)
// ============================================================================

export const NavigateArgsSchema = z.object({
  url: z.string().url().describe('URL to navigate to (must be within allowed base URL)'),
});

export const GoBackArgsSchema = z.object({});

export const GoForwardArgsSchema = z.object({});

export const RefreshArgsSchema = z.object({});

export const GetCurrentUrlArgsSchema = z.object({});

// ============================================================================
// Observation Schemas
// ============================================================================

export const ScreenshotArgsSchema = z.object({
  full_page: z.coerce.boolean().optional().default(false)
    .describe('Capture full page screenshot (default: false for viewport only)'),
});

export const ReadVisibleTextArgsSchema = z.object({});

export const GetPageTitleArgsSchema = z.object({});

// ============================================================================
// Element Locator Base Schema (without refinement for extension)
// ============================================================================

const ElementLocatorBase = {
  text: z.string().optional()
    .describe('Visible text content to find the element'),
  role: z.enum(ARIA_ROLES).optional()
    .describe('ARIA role of the element'),
  name: z.string().optional()
    .describe('Accessible name (aria-label, aria-labelledby, or label text)'),
  index: z.coerce.number().optional()
    .describe('Index when multiple matching elements exist (0-based)'),
};

// ============================================================================
// Interaction Schemas
// ============================================================================

export const ClickArgsSchema = z.object(ElementLocatorBase).refine(
  (data) => data.text !== undefined || data.role !== undefined,
  { message: 'Must specify either text or role to identify an element' }
);

export const TypeTextArgsSchema = z.object({
  ...ElementLocatorBase,
  value: z.string().describe('Text to type into the field'),
  clear: z.coerce.boolean().optional().default(false)
    .describe('Clear existing text before typing (default: false)'),
}).refine(
  (data) => data.text !== undefined || data.role !== undefined,
  { message: 'Must specify either text or role to identify an element' }
);

export const SelectOptionArgsSchema = z.object({
  ...ElementLocatorBase,
  value: z.string().describe('Value or label of the option to select'),
}).refine(
  (data) => data.text !== undefined || data.role !== undefined,
  { message: 'Must specify either text or role to identify an element' }
);

export const CheckArgsSchema = z.object({
  ...ElementLocatorBase,
  checked: z.coerce.boolean().describe('True to check, false to uncheck'),
}).refine(
  (data) => data.text !== undefined || data.role !== undefined,
  { message: 'Must specify either text or role to identify an element' }
);

export const HoverArgsSchema = z.object(ElementLocatorBase).refine(
  (data) => data.text !== undefined || data.role !== undefined,
  { message: 'Must specify either text or role to identify an element' }
);

export const PressKeyArgsSchema = z.object({
  key: z.string().describe('Key to press (e.g., "Enter", "Tab", "Escape", "ArrowDown")'),
});

export const UploadFileArgsSchema = z.object({
  ...ElementLocatorBase,
  file_path: z.string().describe('Absolute path to file to upload'),
}).refine(
  (data) => data.text !== undefined || data.role !== undefined,
  { message: 'Must specify either text or role to identify an element' }
);

export const DragAndDropArgsSchema = z.object({
  source_text: z.string().describe('Visible text of the element to drag'),
  target_text: z.string().describe('Visible text of the drop target'),
});

// ============================================================================
// Scrolling Schemas
// ============================================================================

export const ScrollArgsSchema = z.object({
  direction: z.enum(SCROLL_DIRECTIONS).describe('Direction to scroll'),
  amount: z.coerce.number().optional().default(300)
    .describe('Pixels to scroll (default: 300)'),
});

export const ScrollToTextArgsSchema = z.object({
  text: z.string().describe('Text to scroll to'),
});

// ============================================================================
// Waiting Schemas
// ============================================================================

export const WaitForTextArgsSchema = z.object({
  text: z.string().describe('Text to wait for'),
  timeout: z.coerce.number().optional().default(5000)
    .describe('Timeout in milliseconds (default: 5000)'),
});

export const WaitForIdleArgsSchema = z.object({
  timeout: z.coerce.number().optional().default(5000)
    .describe('Timeout in milliseconds (default: 5000)'),
});

// ============================================================================
// Thought Bubble Schemas
// ============================================================================

export const ShowThoughtArgsSchema = z.object({
  text: z.string().max(500).describe('The thought to display in the overlay bubble. Think out loud about what you see, expect, or feel.'),
});

export const HideThoughtArgsSchema = z.object({});

// ============================================================================
// Tab Management Schemas
// ============================================================================

export const OpenTabArgsSchema = z.object({
  name: z.string().min(1).max(50).describe('Name for the tab (e.g., "terminal", "editor")'),
  url: z.string().url().describe('URL to open in the new tab'),
});

export const SwitchTabArgsSchema = z.object({
  name: z.string().min(1).max(50).describe('Name of the tab to switch to'),
});

export const ListTabsArgsSchema = z.object({});

export const CloseTabArgsSchema = z.object({
  name: z.string().min(1).max(50).describe('Name of the tab to close'),
});

// ============================================================================
// Terminal Interaction Schemas
// ============================================================================

export const TypeTerminalCommandArgsSchema = z.object({
  command: z.string().describe('Command to type in the terminal'),
  delay: z.coerce.number().optional().default(40).describe('Delay between keystrokes in ms (default: 40)'),
  press_enter: z.coerce.boolean().optional().default(true).describe('Press Enter after typing (default: true)'),
});

export const WaitForTerminalOutputArgsSchema = z.object({
  pattern: z.string().describe('Text pattern to wait for in terminal output'),
  timeout: z.coerce.number().optional().default(30000).describe('Timeout in ms (default: 30000)'),
});

// ============================================================================
// Editor Interaction Schemas
// ============================================================================

export const TypeCodeArgsSchema = z.object({
  code: z.string().describe('Code to type in the editor'),
  delay: z.coerce.number().optional().default(30).describe('Delay between keystrokes in ms (default: 30)'),
  clear_first: z.coerce.boolean().optional().default(true).describe('Clear existing content before typing (default: true)'),
});

export const RunCodeArgsSchema = z.object({});

export const GetCodeOutputArgsSchema = z.object({});

// ============================================================================
// Type Definitions
// ============================================================================

export type NavigateArgs = z.infer<typeof NavigateArgsSchema>;
export type GoBackArgs = z.infer<typeof GoBackArgsSchema>;
export type GoForwardArgs = z.infer<typeof GoForwardArgsSchema>;
export type RefreshArgs = z.infer<typeof RefreshArgsSchema>;
export type GetCurrentUrlArgs = z.infer<typeof GetCurrentUrlArgsSchema>;
export type ScreenshotArgs = z.infer<typeof ScreenshotArgsSchema>;
export type ReadVisibleTextArgs = z.infer<typeof ReadVisibleTextArgsSchema>;
export type GetPageTitleArgs = z.infer<typeof GetPageTitleArgsSchema>;
export type ClickArgs = z.infer<typeof ClickArgsSchema>;
export type TypeTextArgs = z.infer<typeof TypeTextArgsSchema>;
export type SelectOptionArgs = z.infer<typeof SelectOptionArgsSchema>;
export type CheckArgs = z.infer<typeof CheckArgsSchema>;
export type HoverArgs = z.infer<typeof HoverArgsSchema>;
export type PressKeyArgs = z.infer<typeof PressKeyArgsSchema>;
export type UploadFileArgs = z.infer<typeof UploadFileArgsSchema>;
export type DragAndDropArgs = z.infer<typeof DragAndDropArgsSchema>;
export type ScrollArgs = z.infer<typeof ScrollArgsSchema>;
export type ScrollToTextArgs = z.infer<typeof ScrollToTextArgsSchema>;
export type WaitForTextArgs = z.infer<typeof WaitForTextArgsSchema>;
export type WaitForIdleArgs = z.infer<typeof WaitForIdleArgsSchema>;
export type ShowThoughtArgs = z.infer<typeof ShowThoughtArgsSchema>;
export type HideThoughtArgs = z.infer<typeof HideThoughtArgsSchema>;
export type OpenTabArgs = z.infer<typeof OpenTabArgsSchema>;
export type SwitchTabArgs = z.infer<typeof SwitchTabArgsSchema>;
export type ListTabsArgs = z.infer<typeof ListTabsArgsSchema>;
export type CloseTabArgs = z.infer<typeof CloseTabArgsSchema>;
export type TypeTerminalCommandArgs = z.infer<typeof TypeTerminalCommandArgsSchema>;
export type WaitForTerminalOutputArgs = z.infer<typeof WaitForTerminalOutputArgsSchema>;
export type TypeCodeArgs = z.infer<typeof TypeCodeArgsSchema>;
export type RunCodeArgs = z.infer<typeof RunCodeArgsSchema>;
export type GetCodeOutputArgs = z.infer<typeof GetCodeOutputArgsSchema>;

// ============================================================================
// Result Types
// ============================================================================

export interface ErrorResult {
  error: string;
}

export interface NavigationResult {
  url: string;
  title: string;
}

export interface ScreenshotResult {
  image: string;
  format: 'png';
}

export interface TextResult {
  text: string;
}

export interface UrlResult {
  url: string;
}

export interface SuccessResult {
  success: boolean;
  message?: string;
}

export interface TabListResult {
  tabs: { name: string; url: string; active: boolean }[];
}
