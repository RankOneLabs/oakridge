import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
// xterm ships its own stylesheet; it must be imported at the consumer or the
// terminal renders unstyled (no viewport/scrollback layout, no cursor). See
// kbbl frontend hard-rule: external library CSS is imported where it is used.
import "@xterm/xterm/css/xterm.css";

/**
 * Imperative handle the parent uses to feed bytes and resize. We write to the
 * xterm instance directly (not through React state) because the PTY byte
 * stream is high-volume — one setState per chunk would be a re-render storm.
 */
export interface SessionTerminalHandle {
  write: (content: string) => void;
  fit: () => void;
}

/**
 * Read-only live view of a session's raw PTY output (the `pty_output` stream).
 * v0 is display-only: stdin is disabled, so keystrokes are not sent back to the
 * subprocess — that needs an upstream write channel and is a separate follow-up.
 *
 * Output is shown from mount forward only: `pty_output` is not persisted, so
 * there is no scrollback to replay for bytes emitted before the terminal opened.
 */
export const SessionTerminal = forwardRef<SessionTerminalHandle, { className?: string }>(
  function SessionTerminal({ className }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const term = new Terminal({
        convertEol: false,
        scrollback: 5000,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 12,
        // Read-only v0: do not capture keystrokes for the PTY.
        disableStdin: true,
        cursorBlink: false,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      try {
        fit.fit();
      } catch {
        // fit throws if the container has no layout yet; the ResizeObserver
        // below refits once it does.
      }
      termRef.current = term;
      fitRef.current = fit;

      const observer = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          // container collapsed to zero size; ignore until it has layout again.
        }
      });
      observer.observe(container);

      return () => {
        observer.disconnect();
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
      };
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        write: (content: string) => termRef.current?.write(content),
        fit: () => {
          try {
            fitRef.current?.fit();
          } catch {
            // no layout yet; ignore.
          }
        },
      }),
      [],
    );

    return <div ref={containerRef} className={className ?? "session-terminal"} />;
  },
);
