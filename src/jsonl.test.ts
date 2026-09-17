import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonlWriter, JsonlWriteError, readJsonl, rowToLine } from './jsonl.js';

const dirs: string[] = [];
function tmpFile(name = 'swaps.jsonl'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-'));
  dirs.push(dir);
  return path.join(dir, 'nested', name);
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('append-only JSONL writer', () => {
  it('creates missing parent directories and the file', () => {
    const file = tmpFile();
    const writer = new JsonlWriter(file);
    writer.close();
    expect(fs.existsSync(file)).toBe(true);
  });

  it('flushes each row before returning, so a reader sees it immediately', () => {
    const file = tmpFile();
    const writer = new JsonlWriter(file);
    try {
      for (let i = 0; i < 5; i++) writer.append({ i, tx_signature: `sig${i}` });
      // No close: the rows must already be on disk after each append.
      expect(readJsonl(file)).toHaveLength(5);
      expect(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(5);
    } finally {
      writer.close();
    }
  });

  it('appends across instances rather than truncating', () => {
    const file = tmpFile();
    const first = new JsonlWriter(file);
    first.append({ tx_signature: 'a' });
    first.close();
    const second = new JsonlWriter(file);
    second.append({ tx_signature: 'b' });
    second.close();
    expect(readJsonl(file)).toEqual([{ tx_signature: 'a' }, { tx_signature: 'b' }]);
  });

  it('writes one complete JSON object per newline-terminated line', () => {
    const file = tmpFile();
    const writer = new JsonlWriter(file);
    writer.append({ pool: 'p', tx_signature: 's' });
    writer.close();
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toBe(rowToLine({ pool: 'p', tx_signature: 's' }));
  });

  it('refuses to write after close', () => {
    const file = tmpFile();
    const writer = new JsonlWriter(file);
    writer.close();
    expect(() => writer.append({ a: 1 })).toThrow(JsonlWriteError);
  });

  it('surfaces a write failure instead of silently losing a row', () => {
    const file = tmpFile();
    const writer = new JsonlWriter(file);
    // Force the underlying fd closed: writeSync then fails with EBADF.
    fs.closeSync(fs.openSync(file, 'r+'));
    (writer as unknown as { fd: number }).fd = -1;
    expect(() => writer.append({ a: 1 })).toThrow(JsonlWriteError);
  });

  it('readJsonl tolerates a missing file and blank lines', () => {
    expect(readJsonl(path.join(os.tmpdir(), 'definitely-not-here.jsonl'))).toEqual([]);
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"a":1}\n\n{"b":2}\n');
    expect(readJsonl(file)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('isolates a crash-truncated tail before appending the next row', () => {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"incomplete":');
    const writer = new JsonlWriter(file);
    writer.append({ tx_signature: 'survives-restart' });
    writer.close();
    expect(readJsonl(file)).toEqual([{ tx_signature: 'survives-restart' }]);
    expect(fs.readFileSync(file, 'utf8')).toContain('\n{"tx_signature":"survives-restart"}\n');
  });
});
