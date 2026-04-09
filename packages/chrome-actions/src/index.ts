/**
 * @gentyr/chrome-actions
 *
 * TypeScript bindings for controlling Chrome via the Claude Chrome Extension's
 * Unix domain socket protocol. Usable directly in test code without Claude in the loop.
 */

export { ChromeActions } from './chrome-actions.js';
export { ChromeSocketClient } from './client.js';
export {
  ChromeNotConnectedError,
  ElementNotFoundError,
  ToolExecutionError,
  NavigationTimeoutError,
  TabNotFoundError,
} from './errors.js';
export type {
  ChromeActionsOptions,
  ChromeSocketClientOptions,
  McpContent,
  ToolResult,
  TabInfo,
  ComputerAction,
  ScrollDirection,
  GifAction,
  GifExportOptions,
  ChromeRequest,
  ChromeSuccessResponse,
  ChromeErrorResponse,
  ChromeResponse,
  TabsContextArgs,
  NavigateArgs,
  ReadPageArgs,
  GetPageTextArgs,
  FormInputArgs,
  JavascriptToolArgs,
  ReadConsoleMessagesArgs,
  ReadNetworkRequestsArgs,
  ResizeWindowArgs,
  GifCreatorArgs,
  UploadImageArgs,
  ShortcutsListArgs,
  ShortcutsExecuteArgs,
  UpdatePlanArgs,
  LeftClickAction,
  RightClickAction,
  DoubleClickAction,
  TripleClickAction,
  HoverAction,
  TypeAction,
  KeyAction,
  ScreenshotAction,
  WaitAction,
  ScrollAction,
  LeftClickDragAction,
  ZoomAction,
  ScrollToAction,
} from './types.js';
