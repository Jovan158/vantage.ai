// Server-sent events, split into the JSON of each event's data. Shared by the
// response formats that stream that way (every one Vantage reads does).

export interface SseParser {
  feed(chunk: Uint8Array | string): void;
  end(): void;
}

// Calls onEvent with the parsed data of every complete event. "[DONE]" and
// data that is not JSON are skipped. Frames may be split across chunks and
// may use \r\n line endings.
export function sseParser(onEvent: (data: unknown) => void): SseParser {
  let buffer = "";
  const decoder = new TextDecoder();

  const frame = (text: string): void => {
    let data = "";
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data || data === "[DONE]") return;
    try {
      onEvent(JSON.parse(data));
    } catch {
      /* partial or not JSON */
    }
  };

  return {
    feed(chunk) {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const text = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (text.trim()) frame(text);
      }
    },
    end() {
      if (buffer.trim()) frame(buffer);
      buffer = "";
    },
  };
}
