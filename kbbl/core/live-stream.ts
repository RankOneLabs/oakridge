// Transport model mirrors the existing /inbox, Oakridge /events and ACP SSE
// routes. Their event data remains unchanged inside the multiplexed envelope.
export type LiveStreamTopic =
  | "/inbox"
  | "/oakridge/api/events"
  | `/sessions/${string}/stream`;

export interface ServerSentEvent {
  event: string;
  data: string;
  id?: string;
}

export interface LiveStreamFrame {
  topic: LiveStreamTopic;
  frame: ServerSentEvent;
}

export interface SseDecoderState {
  pending: string;
  event: string;
  data: string[];
  id: string | undefined;
}

export function createSseDecoderState(): SseDecoderState {
  return { pending: "", event: "message", data: [], id: undefined };
}

export interface DecodedSseChunk {
  state: SseDecoderState;
  frames: ServerSentEvent[];
}

/** Incremental SSE decoding: UTF-8 is decoded by the IO reader first. */
export function decodeSseChunk(previous: SseDecoderState, chunk: string): DecodedSseChunk {
  const state = { ...previous, pending: previous.pending + chunk, data: [...previous.data] };
  const frames: ServerSentEvent[] = [];
  // A loop is clearer here: each line mutates the current frame accumulator.
  while (true) {
    const newline = state.pending.search(/[\r\n]/);
    if (newline < 0) break;
    if (state.pending[newline] === "\r" && newline === state.pending.length - 1) break;
    const line = state.pending.slice(0, newline);
    const separatorLength = state.pending.slice(newline, newline + 2) === "\r\n" ? 2 : 1;
    state.pending = state.pending.slice(newline + separatorLength);
    if (line === "") {
      if (state.data.length > 0) {
        frames.push({ event: state.event, data: state.data.join("\n"), ...(state.id === undefined ? {} : { id: state.id }) });
      }
      state.event = "message";
      state.data = [];
      // SSE ids persist until another id field (including an empty id)
      // replaces them, even when intervening frames omit the field.
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") state.event = value || "message";
    if (field === "data") state.data.push(value);
    if (field === "id" && !value.includes("\0")) state.id = value;
  }
  return { state, frames };
}
