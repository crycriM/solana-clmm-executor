/**
 * Append-only JSONL sink: one `fs.writeSync` per row.
 *
 * Buffered batch writes are unsafe because a buffered line can be lost when
 * the process dies. `writeSync` on an append-mode fd is a single syscall per
 * row, so a row is on disk (visible to a reader) before `append()` returns.
 *
 * The consumer is `dlmm_bot.swap_observer.JsonlSwapEventSource`, which tracks a
 * byte offset and re-reads from zero if the file shrinks. A crash-shortened tail
 * is isolated on the next start so subsequent complete rows remain readable.
 */

import fs from 'node:fs';
import path from 'node:path';

export class JsonlWriteError extends Error {}

/** One row, serialized. Exported so tests can assert on exact framing. */
export function rowToLine(row: unknown): string {
  return JSON.stringify(row) + '\n';
}

/**
 * Append-only JSONL file writer.
 *
 * A partial write is not tolerated: we loop over short writes and raise when
 * the filesystem cannot finish the row. On restart, the constructor isolates
 * any incomplete fragment before a new valid line is appended.
 */
export class JsonlWriter {
  private fd: number;
  private closed = false;

  constructor(private readonly file: string) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.fd = fs.openSync(file, 'a');
    // A crash can leave a half-written row with no trailing newline. Isolate
    // it so the next valid row starts on a fresh line: the Python tailer skips
    // the malformed fragment instead of losing the rows behind it.
    if (this.needsLineBreak()) this.writeAll(Buffer.from('\n'));
  }

  /**
   * True when the file's last byte is not a newline.
   *
   * Read through a separate read-only descriptor: the append-mode fd above is
   * write-only, and `readSync` on it fails with EBADF.
   */
  private needsLineBreak(): boolean {
    let read: number | null = null;
    try {
      read = fs.openSync(this.file, 'r');
      const stat = fs.fstatSync(read);
      if (stat.size === 0) return false;
      const last = Buffer.alloc(1);
      fs.readSync(read, last, 0, 1, stat.size - 1);
      return last[0] !== 0x0a;
    } catch {
      // Unreadable tail: append anyway rather than refuse to start the stream.
      return false;
    } finally {
      if (read !== null) {
        try {
          fs.closeSync(read);
        } catch {
          // Nothing to recover; the descriptor is going away either way.
        }
      }
    }
  }

  get path(): string {
    return this.file;
  }

  append(row: unknown): void {
    if (this.closed) throw new JsonlWriteError('JSONL writer is closed');
    this.writeAll(Buffer.from(rowToLine(row), 'utf8'));
  }

  /** Loop because a single `writeSync` may take only part of the buffer. */
  private writeAll(bytes: Buffer): void {
    let offset = 0;
    while (offset < bytes.length) {
      let written: number;
      try {
        written = fs.writeSync(this.fd, bytes, offset, bytes.length - offset);
      } catch (error) {
        throw new JsonlWriteError(
          `swap stream write failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (written <= 0) {
        throw new JsonlWriteError('swap stream write made no progress');
      }
      offset += written;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    fs.closeSync(this.fd);
  }
}

/** Read back whole JSONL rows; used by tests and the cross-language check. */
export function readJsonl(file: string): unknown[] {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const rows: unknown[] = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Match JsonlSwapEventSource: malformed/crash-truncated rows are skipped,
      // while later complete rows remain readable.
      if (index === lines.length - 1 && !text.endsWith('\n')) break;
      continue;
    }
  }
  return rows;
}
