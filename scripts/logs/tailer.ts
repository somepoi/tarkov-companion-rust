/**
 * Incremental, read-only file tailing. Each FileTail remembers how far it has
 * read and returns the new entries on every poll. Files are opened with 'r'
 * only and closed immediately, so the game is never blocked from writing.
 */
import fs from 'node:fs'
import { LogEntrySplitter, type LogEntry } from './parser'

const CHUNK = 256 * 1024

export class FileTail {
  readonly path: string
  private offset = 0
  private splitter = new LogEntrySplitter()
  private decoder = new TextDecoder('utf-8')

  constructor(filePath: string, startAtEnd = false) {
    this.path = filePath
    if (startAtEnd) {
      try {
        this.offset = fs.statSync(filePath).size
      } catch {
        this.offset = 0
      }
    }
  }

  /** Reads whatever was appended since the last call. */
  poll(): LogEntry[] {
    let size: number
    try {
      size = fs.statSync(this.path).size
    } catch {
      return []
    }
    if (size < this.offset) {
      // Truncated or replaced: start over.
      this.offset = 0
      this.splitter = new LogEntrySplitter()
      this.decoder = new TextDecoder('utf-8')
    }
    if (size === this.offset) return []

    const out: LogEntry[] = []
    let fd: number | null = null
    try {
      fd = fs.openSync(this.path, 'r')
      const buf = Buffer.allocUnsafe(CHUNK)
      while (this.offset < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - this.offset), this.offset)
        if (n <= 0) break
        this.offset += n
        // stream: true keeps multi-byte characters split across reads intact
        out.push(...this.splitter.push(this.decoder.decode(buf.subarray(0, n), { stream: true })))
      }
    } catch {
      // File locked or vanished mid-read: try again on the next poll.
    } finally {
      if (fd !== null) fs.closeSync(fd)
    }
    return out
  }

  /** Reads a whole file in one go (backfills). */
  static readAll(filePath: string): LogEntry[] {
    const tail = new FileTail(filePath)
    const entries = tail.poll()
    return [...entries, ...tail.splitter.flush()]
  }
}
