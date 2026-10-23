/** Logs to stderr; stdout carries the MCP protocol when running over stdio. */
export function log(message: string): void {
  process.stderr.write(`[skill-manager] ${new Date().toISOString()} ${message}\n`);
}
