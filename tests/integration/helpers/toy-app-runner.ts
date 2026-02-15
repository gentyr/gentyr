/**
 * Toy App Runner for Integration Tests
 *
 * Starts the toy-app server on a free port and provides a cleanup function.
 * Used by feedback E2E tests to exercise real HTTP API and CLI interfaces.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';

const TOY_APP_PATH = path.resolve(__dirname, '../../fixtures/toy-app/server.js');

export interface ToyAppInstance {
  /** The port the toy app is listening on */
  port: number;
  /** Base URL for API requests */
  baseUrl: string;
  /** Stop the toy app server */
  stop: () => Promise<void>;
}

/**
 * Start the toy app on a free port.
 * Waits for the "running at" output to confirm it's ready.
 * Returns the port and a cleanup function.
 */
export async function startToyApp(): Promise<ToyAppInstance> {
  return new Promise<ToyAppInstance>((resolve, reject) => {
    const child: ChildProcess = spawn('node', [TOY_APP_PATH], {
      env: { ...process.env, PORT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill();
        reject(new Error(`Toy app failed to start within 5s. stdout: ${stdout}, stderr: ${stderr}`));
      }
    }, 5000);

    child.stdout?.on('data', (data) => {
      stdout += data.toString();

      // Look for "running at http://localhost:PORT/"
      const match = stdout.match(/running at http:\/\/localhost:(\d+)/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);

        const port = parseInt(match[1], 10);
        const baseUrl = `http://localhost:${port}`;

        resolve({
          port,
          baseUrl,
          stop: () => stopToyApp(child),
        });
      }
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`Toy app process error: ${err.message}`));
      }
    });

    child.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`Toy app exited with code ${code} before ready. stderr: ${stderr}`));
      }
    });
  });
}

/**
 * Stop a toy app instance gracefully.
 */
function stopToyApp(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    if (child.killed || child.exitCode !== null) {
      resolve();
      return;
    }

    const forceKillTimeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3000);

    child.on('exit', () => {
      clearTimeout(forceKillTimeout);
      resolve();
    });

    child.kill('SIGTERM');
  });
}
