/**
 * The plugin's own activity log and counters.
 *
 * Both are plain, bounded, process-local records: the settings page reads the
 * last few lines to explain a connection that will not come up, and the host
 * log gets the same line through `ctx.logger`. Nothing here is durable — a
 * restart is expected to forget, because every fact it reports is re-derivable
 * from the live connection.
 *
 * @module dsh-feishu-session-manager/log
 */

import type { LogEntry } from './protocol.ts'

/** Ring buffer of recent activity, newest last. */
export class ActivityLog {
  private readonly entries: LogEntry[] = []

  /**
   * @param limit - maximum retained lines.
   */
  constructor(private readonly limit: number = 200) {}

  /**
   * Append one line, dropping the oldest when the buffer is full.
   * @param level - severity.
   * @param text - human-readable message.
   */
  add(level: LogEntry['level'], text: string): void {
    this.entries.push({ at: Date.now(), level, text })
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit)
  }

  /**
   * Read the retained lines, oldest first.
   * @returns a copy, so a caller cannot mutate the buffer.
   */
  list(): LogEntry[] {
    return this.entries.slice()
  }

  /** Drop every line. */
  clear(): void {
    this.entries.length = 0
  }
}

/** Monotonic counters for the status panel. */
export class Counters {
  inbound = 0
  outbound = 0
  notifications = 0
  routed = 0
  errors = 0

  /**
   * Increment one counter.
   * @param name - counter field.
   */
  bump(name: 'inbound' | 'outbound' | 'notifications' | 'routed' | 'errors'): void {
    this[name] += 1
  }
}