/**
 * Vibecraft Server Logger
 *
 * Provides timestamped logging with optional debug mode.
 * Debug mode is enabled via setDebug() at startup.
 */

let debugEnabled = false;

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

export function debug(...args: unknown[]): void {
  if (debugEnabled) {
    console.log(`[DEBUG ${new Date().toISOString()}]`, ...args);
  }
}
