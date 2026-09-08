import { useEffect, useRef, useState } from "react";
import { Terminal as TerminalIcon } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { BaiClient } from "@bai/api/client";
import type { ThemeColors } from "@bai/shared";

/**
 * The web shell pane: one xterm.js terminal over a WebSocket to the
 * server's persistent bash session (packages/api/src/server/shell.ts).
 *
 * The server side is a real PTY (python3 bridge), so the shell echoes
 * typed characters, colors, and handles ctrl-c itself — the client just
 * forwards raw bytes both ways. One shell per connection: navigating away
 * (or a refresh) ends the session; reconnects spawn a fresh one.
 *
 * Control frames are 6-byte binary packets: 0x00 0xFF magic, then rows and
 * cols as u16 big-endian — a byte pair terminal input never starts with
 * (a lone NUL is ctrl-space and forwards untouched). Everything else is
 * raw terminal bytes both ways.
 */

/** Resize-packet magic (must match api/src/server/shell.ts). */
const RESIZE_MAGIC = [0x00, 0xff];

function resizePacket(rows: number, cols: number): Uint8Array {
  return new Uint8Array([
    ...RESIZE_MAGIC,
    (rows >> 8) & 0xff,
    rows & 0xff,
    (cols >> 8) & 0xff,
    cols & 0xff,
  ]);
}

export function ShellPane({
  client,
  themeColors,
}: {
  client: BaiClient;
  themeColors: ThemeColors;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Connection status: connecting → open | closed (retrying) | denied
  // (auth rejected beyond loopback). The server closes cleanly when the
  // shell exits — that reads as "closed" and reconnects to a fresh shell.
  const [status, setStatus] = useState<"connecting" | "open" | "closed" | "denied">("connecting");
  // Monotonic reconnect epoch — the WS effect's key. The close handler
  // bumps it (after backoff) to tear down and reconnect; status changes
  // alone never re-run the effect (they'd kill the live socket).
  const [connectEpoch, setConnectEpoch] = useState(0);

  // The terminal + WebSocket live in one effect keyed on the reconnect
  // epoch (bumped by the close handler's retry timer).
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    let disposed = false;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, monospace',
      theme: {
        background: hexOr(themeColors.surface, "#09090b"),
        foreground: themeColors.text,
        cursor: themeColors.text,
        cursorAccent: themeColors.surface,
        selectionBackground: themeColors.primary,
        black: themeColors.surface,
        red: themeColors.danger,
        green: themeColors.success,
        yellow: themeColors.warning,
        blue: themeColors.primary,
        magenta: themeColors.accent,
        cyan: themeColors.secondary,
        white: themeColors.text,
        brightBlack: themeColors.textMuted,
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      // zero-sized host (hidden pane) — the ResizeObserver fits later
    }
    term.onData((data) => ws?.send(data));
    term.focus();

    const sendResize = (): void => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      ws.send(resizePacket(term.rows, term.cols));
    };
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        sendResize();
      } catch {
        // host collapsed — nothing to fit
      }
    });
    ro.observe(host);

    const url = client.shellWsUrl();
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      if (disposed) return;
      setStatus("open");
      sendResize();
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") term.write(e.data);
      else term.write(new Uint8Array(e.data));
    };
    ws.onclose = (e) => {
      if (disposed) return;
      // 1008 = policy rejection (bad/missing token beyond loopback) — a
      // stable condition, no retry. Anything else (server unreachable,
      // shell exited) reconnects with backoff to a fresh shell.
      if (e.code === 1008) {
        setStatus("denied");
        return;
      }
      setStatus("closed");
      retryTimer = setTimeout(() => {
        if (!disposed) setConnectEpoch((n) => n + 1);
      }, Math.min(5000, 500 * 2 ** Math.min(connectEpoch, 4)));
    };
    ws.onerror = () => {
      // onclose follows — the retry logic lives there
    };

    return () => {
      disposed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      ro.disconnect();
      ws?.close();
      term.dispose();
    };
    // connectEpoch is the reconnect key; connectEpoch only feeds the
    // backoff math above (stale-in-closure is fine — it's the epoch this
    // connection was born in).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, themeColors, connectEpoch]);

  return (
    <div className="shell-pane">
      <div className="shell-header">
        <TerminalIcon className="nav-icon" aria-hidden="true" />
        <span>Shell</span>
        <span className={`shell-status shell-status-${status}`}>
          {status === "open"
            ? "connected"
            : status === "connecting"
              ? "connecting…"
              : status === "denied"
                ? "unavailable — pairing token required"
                : `reconnecting (attempt ${connectEpoch})…`}
        </span>
      </div>
      {status === "denied" ? (
        <div className="shell-denied">
          <p>
            The shell is arbitrary code execution on the server machine, so beyond
            loopback it requires the pairing token. Open bai from 127.0.0.1 (or
            with the token configured) to use it.
          </p>
        </div>
      ) : (
        <div ref={hostRef} className="shell-terminal" />
      )}
    </div>
  );
}

/** xterm needs concrete colors — pass through hex, fall back otherwise. */
function hexOr(value: string, fallback: string): string {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? value : fallback;
}
