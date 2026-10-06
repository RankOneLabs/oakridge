import type { RunEventFrame } from "../types";

/** Run-event notifications resume when the authority exposes an event route. */
export function useOakridgeRunEventStream(_isEnabled: boolean, _subscriber: (frame: RunEventFrame) => void): void {}
