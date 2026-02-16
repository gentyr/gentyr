/**
 * MCP Servers Package
 *
 * Provides MCP (Model Context Protocol) servers for Claude Code integration.
 *
 * Available servers:
 * - specs-browser: Browse project specification files
 * - review-queue: Manage schema mapping review queue
 * - agent-tracker: Track Claude agents spawned by hooks
 * - todo-db: Task management via SQLite database
 * - session-events: Session event recording and analysis
 * - cto-reports: Global CTO reporting system (all agents)
 * - deputy-cto: Deputy-CTO private toolset (deputy-cto only)
 * - cto-report: CTO metrics and status reports
 *
 * @packageDocumentation
 */

// Re-export shared types
export * from './shared/index.js';

// Re-export server-specific types
export * as SpecsBrowser from './specs-browser/index.js';
export * as ReviewQueue from './review-queue/index.js';
export * as AgentTracker from './agent-tracker/index.js';
export * as TodoDb from './todo-db/index.js';
export * as SessionEvents from './session-events/index.js';
export * as CtoReports from './cto-reports/index.js';
export * as DeputyCto from './deputy-cto/index.js';
export * as CtoReport from './cto-report/index.js';
export * as MakerkitDocs from './makerkit-docs/index.js';
export * as SetupHelper from './setup-helper/index.js';
