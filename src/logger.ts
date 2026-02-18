export function logInfo(message: string, details?: Record<string, unknown>): void {
  if (details) {
    console.log(`[INFO] ${message}`, details);
    return;
  }
  console.log(`[INFO] ${message}`);
}

export function logError(message: string, details?: Record<string, unknown>): void {
  if (details) {
    console.error(`[ERROR] ${message}`, details);
    return;
  }
  console.error(`[ERROR] ${message}`);
}
