/**
 * Silent error logger for preview auto-fix diagnostics.
 *
 * Stores structured entries in localStorage (ring buffer, max 100)
 * and prints grouped console output for power-user debugging.
 * The UI never shows these to the end user.
 */

const STORAGE_KEY = "vedaa-error-log";
const MAX_ENTRIES = 100;

export interface ErrorLogEntry {
  timestamp: string;
  type: "preview_error" | "autofix_start" | "autofix_result";
  message: string;
  stack?: string;
  iteration?: number;
  file?: string;
  resolved?: boolean;
}

// ── Internal ──────────────────────────────────────────────────

function _appendEntry(entry: ErrorLogEntry): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const log: ErrorLogEntry[] = raw ? JSON.parse(raw) : [];
    log.push(entry);
    if (log.length > MAX_ENTRIES) log.splice(0, log.length - MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(log));
  } catch {
    // Safari private browsing or quota exceeded — silently ignore
  }
}

// ── Public API ────────────────────────────────────────────────

export function logPreviewError(message: string, stack?: string, file?: string): void {
  const entry: ErrorLogEntry = {
    timestamp: new Date().toISOString(),
    type: "preview_error",
    message,
    stack,
    file,
  };
  _appendEntry(entry);

  try {
    console.groupCollapsed(`%c[Vedaa] Preview error`, "color:#f38ba8");
    console.error(message);
    if (stack) console.debug(stack);
    console.groupEnd();
  } catch {
    // no-op
  }
}

export function logAutoFixStart(iteration: number, errors: string[]): void {
  const entry: ErrorLogEntry = {
    timestamp: new Date().toISOString(),
    type: "autofix_start",
    message: `Iteration ${iteration} — ${errors.length} error(s)`,
    iteration,
  };
  _appendEntry(entry);

  try {
    console.groupCollapsed(
      `%c[Vedaa] Auto-fix start — iteration ${iteration}`,
      "color:#89b4fa",
    );
    errors.forEach((e) => console.log("  •", e));
    console.groupEnd();
  } catch {
    // no-op
  }
}

export function logAutoFixResult(
  iteration: number,
  success: boolean,
  filesFixed?: string[],
): void {
  const entry: ErrorLogEntry = {
    timestamp: new Date().toISOString(),
    type: "autofix_result",
    message: success
      ? `Iteration ${iteration} succeeded (${filesFixed?.length ?? 0} files)`
      : `Iteration ${iteration} failed`,
    iteration,
    resolved: success,
  };
  _appendEntry(entry);

  try {
    if (success) {
      console.log(
        `%c[Vedaa] Auto-fix resolved in iteration ${iteration}`,
        "color:#a6e3a1",
        filesFixed,
      );
    } else {
      console.warn(
        `%c[Vedaa] Auto-fix iteration ${iteration} failed`,
        "color:#fab387",
      );
    }
  } catch {
    // no-op
  }
}

export function getErrorLog(): ErrorLogEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function clearErrorLog(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // no-op
  }
}
