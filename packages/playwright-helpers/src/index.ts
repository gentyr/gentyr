export {
  injectPersonaOverlay,
  updateOverlayStatus,
  updateOverlayStep,
  setupDemoOverlays,
  showThinking,
  hideThinking,
  showThinkingLoader,
  type PersonaColors,
  type OverlayConfig,
  type OverlayConfigBase,
  type DemoOverlayConfig,
  type FeedbackOverlayConfig,
} from './persona-overlay.js';

export {
  openTerminalTab,
  typeCommand,
  waitForOutput,
  waitForPrompt,
  clearTerminal,
  getTerminalUrl,
  DEFAULT_TERMINAL_URL,
  XTERM_SELECTORS,
  type TypeCommandOptions,
} from './terminal-tab.js';

export {
  openEditorTab,
  typeCode,
  getEditorContent,
  runCode,
  getConsoleOutput,
  buildEditorUrl,
  DEFAULT_EDITOR_URL,
  EDITOR_SELECTORS,
  selectAllShortcut,
  type EditorConfig,
  type TypeCodeOptions,
} from './editor-tab.js';

export {
  CURSOR_HIGHLIGHT_SCRIPT,
  addMouseAnimation,
} from './cursor-highlight.js';

export {
  DemoInterruptedError,
  isInterrupted,
  throwIfInterrupted,
  getInterruptPromise,
  enableDemoInterrupt,
} from './interrupt.js';
