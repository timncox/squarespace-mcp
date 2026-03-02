import { spawn, type ChildProcess } from 'child_process';
import { createConnection } from 'net';
import { homedir } from 'os';
import { join } from 'path';
import { logger } from './logger.js';

const proxyLogger = logger.child({ component: 'proxy' });

let proxyProcess: ChildProcess | null = null;

/**
 * Parse the proxy port from ANTHROPIC_BASE_URL, defaulting to 42069.
 */
function getProxyPort(): number {
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      if (url.port) return parseInt(url.port, 10);
    } catch {
      // Malformed URL — fall through to default
    }
  }
  return 42069;
}

/**
 * Check whether a port is already in use via a TCP connect test.
 */
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Poll until the proxy port is accepting TCP connections, or timeout.
 * 20 attempts, 500ms apart = 10s max.
 */
async function waitForReady(port: number): Promise<boolean> {
  const maxAttempts = 20;
  const intervalMs = 500;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (await isPortInUse(port)) {
      proxyLogger.info({ attempt, port }, 'Proxy is accepting connections');
      return true;
    }
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  return false;
}

/**
 * Ensure the claude-code-proxy is running before the server starts.
 *
 * - If the proxy port is already in use, assumes it's running and returns.
 * - Otherwise, spawns the proxy process and waits for its /health endpoint.
 * - On failure, logs a warning but does NOT throw (non-AI features still work).
 */
export async function ensureProxy(): Promise<void> {
  const port = getProxyPort();
  const proxyPath = process.env.PROXY_PATH || join(homedir(), 'claude-code-proxy');

  // Check if already running
  if (await isPortInUse(port)) {
    proxyLogger.info({ port }, 'Proxy already running — skipping spawn');
    return;
  }

  proxyLogger.info({ port, proxyPath }, 'Starting claude-code-proxy');

  try {
    proxyProcess = spawn('node', ['server/server.js'], {
      cwd: proxyPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    // Pipe stdout through pino logger
    proxyProcess.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        proxyLogger.info(line);
      }
    });

    // Pipe stderr through pino logger
    proxyProcess.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        proxyLogger.warn(line);
      }
    });

    proxyProcess.on('error', (err) => {
      proxyLogger.error({ error: err }, 'Proxy process error');
      proxyProcess = null;
    });

    proxyProcess.on('exit', (code, signal) => {
      proxyLogger.warn({ code, signal }, 'Proxy process exited');
      proxyProcess = null;
    });

    proxyLogger.info({ pid: proxyProcess.pid }, 'Proxy process spawned — waiting for health check');

    // Wait for the proxy to become ready
    const healthy = await waitForReady(port);
    if (!healthy) {
      proxyLogger.warn(
        { port },
        'Proxy did not become ready within 10s — AI features may not work',
      );
    }
  } catch (err) {
    proxyLogger.warn({ error: err, proxyPath }, 'Failed to start proxy — AI features may not work');
    proxyProcess = null;
  }
}

/**
 * Kill the proxy child process if we spawned it.
 */
export function stopProxy(): void {
  if (proxyProcess) {
    const pid = proxyProcess.pid;
    proxyLogger.info({ pid }, 'Stopping proxy process');
    proxyProcess.kill('SIGTERM');
    proxyProcess = null;
  }
}
