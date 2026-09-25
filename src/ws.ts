// WebSocket frames, read from a copy of the bytes a connection carries — the
// bytes themselves pass through the proxy untouched. Codex streams its model
// turns over a WebSocket; each message is one JSON event, the same events the
// HTTP stream carries.
//
// Frames are collected without copying until one is complete, so a large
// message (a request carries the whole conversation) costs one copy. Past a
// cap, or on a compressed frame (Vantage asks for none, see proxy.ts), the
// reader stops: observation must never cost the session anything.

const MAX_MESSAGE = 32 * 1024 * 1024;

export class WsReader {
  private chunks: Buffer[] = [];
  private length = 0;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentOpcode = 0;
  private stopped = false;
  private readonly onMessage: (text: string) => void;

  constructor(onMessage: (text: string) => void) {
    this.onMessage = onMessage;
  }

  feed(chunk: Buffer): void {
    if (this.stopped) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
    try {
      while (this.frame());
    } catch {
      this.stop();
    }
  }

  private stop(): void {
    this.stopped = true;
    this.chunks = [];
    this.fragments = [];
  }

  private peek(n: number): Buffer {
    if (this.chunks[0]!.length >= n) return this.chunks[0]!;
    const all = Buffer.concat(this.chunks);
    this.chunks = [all];
    return all;
  }

  private take(n: number): Buffer {
    const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
    const out = Buffer.from(all.subarray(0, n));
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.length = rest.length;
    return out;
  }

  // Reads one frame if it is complete; false when more bytes are needed.
  private frame(): boolean {
    if (this.length < 2) return false;
    let head = this.peek(Math.min(this.length, 14));
    const b0 = head[0]!;
    const b1 = head[1]!;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (this.length < 4) return false;
      head = this.peek(4);
      len = head.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (this.length < 10) return false;
      head = this.peek(10);
      const big = head.readBigUInt64BE(2);
      if (big > BigInt(MAX_MESSAGE)) {
        this.stop();
        return false;
      }
      len = Number(big);
      off = 10;
    }
    const masked = (b1 & 0x80) !== 0;
    if (len > MAX_MESSAGE) {
      this.stop();
      return false;
    }
    const total = off + (masked ? 4 : 0) + len;
    if (this.length < total) return false;
    const frame = this.take(total);
    const payload = frame.subarray(off + (masked ? 4 : 0));
    if (masked) {
      const mask = frame.subarray(off, off + 4);
      for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
    }

    const fin = (b0 & 0x80) !== 0;
    const compressed = (b0 & 0x40) !== 0;
    const opcode = b0 & 0x0f;
    if (compressed) {
      this.stop();
      return false;
    }
    if (opcode >= 0x8) return true; // close, ping, pong
    if (opcode === 0x0) {
      this.fragments.push(payload);
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > MAX_MESSAGE) {
        this.stop();
        return false;
      }
      if (fin) this.deliver(this.fragmentOpcode, Buffer.concat(this.fragments));
    } else if (fin) {
      this.deliver(opcode, payload);
    } else {
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
      this.fragmentBytes = payload.length;
    }
    return true;
  }

  private deliver(opcode: number, payload: Buffer): void {
    this.fragments = [];
    this.fragmentBytes = 0;
    if (opcode !== 0x1) return; // only text messages carry JSON
    try {
      this.onMessage(payload.toString("utf8"));
    } catch {
      /* observation only */
    }
  }
}

// A frame as a client sends it (masked) or a server sends it — for tests and
// the mock upstream.
export function wsFrame(text: string, mask: boolean): Buffer {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  const head: number[] = [0x81];
  const maskBit = mask ? 0x80 : 0;
  if (len < 126) head.push(maskBit | len);
  else if (len < 65536) head.push(maskBit | 126, len >> 8, len & 0xff);
  else {
    head.push(maskBit | 127);
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(len));
    head.push(...b);
  }
  if (!mask) return Buffer.concat([Buffer.from(head), payload]);
  const key = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i]! ^= key[i & 3]!;
  return Buffer.concat([Buffer.from(head), key, body]);
}
