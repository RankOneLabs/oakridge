// Transport abstraction for the Codex app-server connection.
// Supported: stdio (spawn process), unix-socket, ws.

export interface CodexTransport {
  writeLine(line: string): Promise<void>;
  lines(): AsyncIterable<string>;
  close(): Promise<void>;
  readonly closed: boolean;
  onClose(handler: () => void): void;
}

// === Stdio transport ===

export interface StdioTransportOpts {
  bin: string;
  args?: string[];
  cwd?: string;
}

export function createStdioTransport(opts: StdioTransportOpts): CodexTransport {
  const proc = Bun.spawn({
    cmd: [opts.bin, ...(opts.args ?? [])],
    cwd: opts.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  let _closed = false;
  const closeHandlers: Array<() => void> = [];

  // Track close
  proc.exited.then(() => {
    _closed = true;
    for (const h of closeHandlers) {
      try { h(); } catch { /* ignore */ }
    }
  });

  // Drain stderr so the pipe buffer never fills and blocks the subprocess
  (async () => {
    try {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch { /* ignore */ }
  })();

  async function writeLine(line: string): Promise<void> {
    if (_closed) throw new Error("transport closed");
    const sink = proc.stdin as import("bun").FileSink;
    sink.write(line + "\n");
    await sink.flush();
  }

  async function* lines(): AsyncIterable<string> {
    const stream = proc.stdout as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const trimCR = (s: string) => (s.endsWith("\r") ? s.slice(0, -1) : s);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buf += decoder.decode();
          if (buf.length > 0) yield trimCR(buf);
          return;
        }
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          yield trimCR(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async function close(): Promise<void> {
    if (!_closed) {
      try { proc.kill(); } catch { /* already dead */ }
    }
  }

  return {
    writeLine,
    lines,
    close,
    get closed() { return _closed; },
    onClose(handler: () => void) { closeHandlers.push(handler); },
  };
}

// === Unix-socket transport ===

export interface UnixSocketTransportOpts {
  path: string;
}

export function createUnixSocketTransport(opts: UnixSocketTransportOpts): CodexTransport {
  let _closed = false;
  const closeHandlers: Array<() => void> = [];

  // Line buffer for incoming data
  const lineQueue: string[] = [];
  let lineWaiter: (() => void) | null = null;
  let buf = "";

  let socketRef: { write(data: string | Uint8Array): number; end(): void } | null = null;

  const connectPromise = new Promise<void>((resolve, reject) => {
    const socket = Bun.connect({
      unix: opts.path,
      socket: {
        open(s) {
          socketRef = s;
          resolve();
        },
        data(_s, data: Uint8Array) {
          const chunk = new TextDecoder().decode(data);
          buf += chunk;
          let idx: number;
          const trimCR = (str: string) =>
            str.endsWith("\r") ? str.slice(0, -1) : str;
          while ((idx = buf.indexOf("\n")) !== -1) {
            lineQueue.push(trimCR(buf.slice(0, idx)));
            buf = buf.slice(idx + 1);
            lineWaiter?.();
            lineWaiter = null;
          }
        },
        close() {
          _closed = true;
          lineWaiter?.();
          lineWaiter = null;
          for (const h of closeHandlers) {
            try { h(); } catch { /* ignore */ }
          }
        },
        error(_s, err) {
          reject(err);
        },
        connectError(_s, err) {
          reject(err);
        },
      },
    });
    void socket;
  });

  async function writeLine(line: string): Promise<void> {
    await connectPromise;
    if (_closed || !socketRef) throw new Error("transport closed");
    socketRef.write(line + "\n");
  }

  async function* lines(): AsyncIterable<string> {
    await connectPromise;
    while (true) {
      while (lineQueue.length > 0) {
        yield lineQueue.shift()!;
      }
      if (_closed) return;
      await new Promise<void>((r) => { lineWaiter = r; });
    }
  }

  async function close(): Promise<void> {
    if (socketRef && !_closed) {
      socketRef.end();
    }
  }

  return {
    writeLine,
    lines,
    close,
    get closed() { return _closed; },
    onClose(handler: () => void) { closeHandlers.push(handler); },
  };
}

// === WebSocket transport ===

export interface WsTransportOpts {
  url: string;
}

export function createWsTransport(opts: WsTransportOpts): CodexTransport {
  let _closed = false;
  const closeHandlers: Array<() => void> = [];

  const lineQueue: string[] = [];
  let lineWaiter: (() => void) | null = null;
  let buf = "";

  let ws: WebSocket | null = null;

  const connectPromise = new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(opts.url);
    ws = socket;

    socket.addEventListener("open", () => {
      resolve();
    });

    socket.addEventListener("message", (event) => {
      const chunk = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
      buf += chunk;
      let idx: number;
      const trimCR = (str: string) =>
        str.endsWith("\r") ? str.slice(0, -1) : str;
      while ((idx = buf.indexOf("\n")) !== -1) {
        lineQueue.push(trimCR(buf.slice(0, idx)));
        buf = buf.slice(idx + 1);
        lineWaiter?.();
        lineWaiter = null;
      }
    });

    socket.addEventListener("close", () => {
      _closed = true;
      lineWaiter?.();
      lineWaiter = null;
      for (const h of closeHandlers) {
        try { h(); } catch { /* ignore */ }
      }
    });

    socket.addEventListener("error", (err) => {
      reject(err);
    });
  });

  async function writeLine(line: string): Promise<void> {
    await connectPromise;
    if (_closed || !ws) throw new Error("transport closed");
    ws.send(line + "\n");
  }

  async function* lines(): AsyncIterable<string> {
    await connectPromise;
    while (true) {
      while (lineQueue.length > 0) {
        yield lineQueue.shift()!;
      }
      if (_closed) return;
      await new Promise<void>((r) => { lineWaiter = r; });
    }
  }

  async function close(): Promise<void> {
    if (ws && !_closed) {
      ws.close();
    }
  }

  return {
    writeLine,
    lines,
    close,
    get closed() { return _closed; },
    onClose(handler: () => void) { closeHandlers.push(handler); },
  };
}
