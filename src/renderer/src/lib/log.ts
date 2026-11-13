/**
 * Renderer-side logging. Lines are forwarded to the main process, which prints
 * them in the terminal and appends them to userData/logs/lyra.log.
 */
export function log(scope: string, message: string, data?: unknown): void {
  console.debug(`[${scope}] ${message}`, data ?? '')
  // Absent outside Electron (e.g. when the audio code runs under a test harness).
  globalThis.window?.api?.log(scope, message, data)
}
