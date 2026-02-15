/**
 * SDK Sandbox
 *
 * Worker thread-based sandboxing for executing user code snippets.
 * Blocks dangerous modules and provides a restricted execution environment.
 */

import { Worker } from 'worker_threads';

/**
 * Blocked modules that pose security risks
 */
const BLOCKED_MODULES = [
  'fs', 'fs/promises',
  'child_process',
  'net', 'dgram', 'dns', 'tls',
  'http', 'https', 'http2',
  'os',
  'path',
  'cluster',
  'worker_threads',
  'process',
  'v8',
  'vm',
  'repl',
];

/**
 * Worker thread code (embedded as string to avoid separate file)
 */
const WORKER_CODE = `
const { parentPort, workerData } = require('worker_threads');

const { code, allowedPackages } = workerData;
const logs = [];
const blockedModules = ${JSON.stringify(BLOCKED_MODULES)};

// Override console.log to capture output
const originalConsoleLog = console.log;
console.log = (...args) => {
  logs.push(args.map(arg => {
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg, null, 2);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  }).join(' '));
  originalConsoleLog(...args);
};

// Create a custom require function
const Module = require('module');
const originalRequire = Module.prototype.require;

Module.prototype.require = function(id) {
  // Block dangerous modules
  if (blockedModules.includes(id)) {
    throw new Error(\`Module "\${id}" is not allowed in sandbox\`);
  }

  // Only allow configured packages
  const isBuiltin = Module.isBuiltin ? Module.isBuiltin(id) : Module.builtinModules.includes(id);
  if (!isBuiltin && !allowedPackages.some(pkg => id === pkg || id.startsWith(pkg + '/'))) {
    throw new Error(\`Module "\${id}" is not in allowed packages: \${allowedPackages.join(', ')}\`);
  }

  return originalRequire.apply(this, arguments);
};

// Execute user code
try {
  const asyncEval = new Function('require', \`
    return (async () => {
      \${code}
    })();
  \`);

  asyncEval(require).then(result => {
    parentPort.postMessage({
      success: true,
      result: result !== undefined ? JSON.stringify(result, null, 2) : 'undefined',
      logs,
    });
  }).catch(err => {
    parentPort.postMessage({
      success: false,
      error: err.message || String(err),
      logs,
    });
  });
} catch (err) {
  parentPort.postMessage({
    success: false,
    error: err.message || String(err),
    logs,
  });
}
`;

export interface SandboxResult {
  result: string;
  logs: string[];
}

export interface SandboxError {
  error: string;
  logs: string[];
}

/**
 * Execute code in a sandboxed worker thread
 */
export async function evaluateInSandbox(
  code: string,
  allowedPackages: string[],
  timeout: number,
): Promise<SandboxResult | SandboxError> {
  return new Promise((resolve) => {
    let completed = false;
    let timeoutHandle: NodeJS.Timeout | null = null;

    const worker = new Worker(WORKER_CODE, {
      eval: true,
      workerData: { code, allowedPackages },
    });

    // Set timeout
    timeoutHandle = setTimeout(() => {
      if (!completed) {
        completed = true;
        worker.terminate();
        resolve({
          error: `Execution timed out after ${timeout}ms`,
          logs: [],
        });
      }
    }, timeout);

    // Handle worker messages
    worker.on('message', (message: { success: boolean; result?: string; error?: string; logs: string[] }) => {
      if (!completed) {
        completed = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        worker.terminate();

        if (message.success) {
          resolve({
            result: message.result || 'undefined',
            logs: message.logs,
          });
        } else {
          resolve({
            error: message.error || 'Unknown error',
            logs: message.logs,
          });
        }
      }
    });

    // Handle worker errors
    worker.on('error', (err) => {
      if (!completed) {
        completed = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        worker.terminate();
        resolve({
          error: err.message || String(err),
          logs: [],
        });
      }
    });

    // Handle worker exit
    worker.on('exit', (code) => {
      if (!completed) {
        completed = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (code !== 0) {
          resolve({
            error: `Worker exited with code ${code}`,
            logs: [],
          });
        }
      }
    });
  });
}
