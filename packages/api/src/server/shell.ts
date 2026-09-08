import { hostname } from "node:os";
import type { WebSocketHandler } from "bun";

/**
 * The web shell: ONE persistent bash session per WebSocket connection,
 * bridged to a real PTY so bash gets line editing, echo, ANSI colors, and
 * ctrl-c (the pty line discipline raises SIGINT in the foreground process
 * group). No native modules — the single-executable build stays intact.
 *
 * The bridge is a tiny python3 select-loop (`pty.fork` + fd pump): Bun's
 * pipes are socketpairs, which macOS `script(1)` rejects (ENOTSUP on
 * tcgetattr) and CPython's `pty.spawn` hangs on after child exit — this
 * bridge handles both EOF directions explicitly. Fallbacks: `script(1)`
 * (Linux, when python3 is missing) and finally bare pipes (no echo/colors/
 * interrupt — degraded but functional).
 *
 * Security: arbitrary code execution. Loopback binds bypass auth by the
 * project's existing stance (auth.ts); beyond loopback the upgrade MUST
 * present the pairing token as `?token=` (browser WebSockets cannot set
 * Authorization headers), compared constant-time.
 */

/** The python3 PTY bridge: pty.fork the shell, pump stdin↔master↔stdout.
 * stdin EOF → SIGHUP the shell (client hung up); SIGTERM/SIGINT → SIGKILL
 * the shell (Bun's proc.kill must not orphan it); master EOF → clean exit.
 * Resize: a 6-byte stdin packet (0x00 0xFF, rows u16 BE, cols u16 BE) sets
 * the pty size via TIOCSWINSZ — the kernel then SIGWINCHs the foreground
 * process group. Partial packets are buffered; a lone NUL (ctrl-space) or
 * any other input is forwarded untouched. */
const PTY_BRIDGE = `
import fcntl,os,pty,select,signal,struct,sys,termios
pid,fd=pty.fork()
if pid==0:
    os.execvp(sys.argv[1],sys.argv[1:])
def die(s,f):
    try: os.kill(pid,signal.SIGKILL)
    except OSError: pass
    sys.exit(1)
signal.signal(signal.SIGTERM,die)
signal.signal(signal.SIGINT,die)
pending=b''
while True:
    try: r,_,_=select.select([fd,0],[],[])
    except (OSError,InterruptedError): continue
    if 0 in r:
        try: d=os.read(0,65536)
        except OSError: d=None
        if d:
            if pending: d=pending+d; pending=b''
            if d[:2]==b'\\x00\\xff':
                if len(d)<6: pending=d; d=b''
                else:
                    rows,cols=struct.unpack('>HH',d[2:6])
                    try: fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0))
                    except OSError: pass
                    d=d[6:]
            if d:
                try: os.write(fd,d)
                except OSError: pass
        else:
            try: os.kill(pid,signal.SIGHUP)
            except OSError: pass
            break
    if fd in r:
        try: d=os.read(fd,65536)
        except OSError: break
        if not d: break
        try: os.write(1,d)
        except OSError: break
try: os.waitpid(pid,0)
except OSError: pass
`;

interface ShellCommand {
  cmd: string[];
  /** "pty" = full terminal semantics; "pipes" = degraded bare bash. */
  mode: "pty" | "pipes";
}

/** Constant-time string comparison (mirrors auth.ts's safeEqual). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Whether a shell upgrade may proceed. Loopback binds bypass by design;
 * beyond loopback a configured token is required in the `?token=` query
 * (no token configured → deny — fail closed).
 */
export function shellAuthorized(
  req: Request,
  deps: { token?: string; loopbackBind: boolean },
): boolean {
  if (deps.loopbackBind) return true;
  if (deps.token === undefined) return false;
  const presented = new URL(req.url).searchParams.get("token") ?? "";
  return presented.length > 0 && safeEqual(presented, deps.token);
}

/** True when a shell backend exists on this machine (bridge, script, or bash). */
export function shellAvailable(): boolean {
  return shellCommand() !== null;
}

/** The argv that bridges a PTY (or bare pipes) to an interactive bash. */
function shellCommand(): ShellCommand | null {
  if (process.platform === "win32") return null; // no bash, no pty bridge
  const bash = ["/bin/bash", "--noprofile", "--norc", "-i"];
  const python3 = python3Path();
  if (python3 !== null) {
    return { cmd: [python3, "-c", PTY_BRIDGE, ...bash], mode: "pty" };
  }
  if (process.platform === "linux") {
    // util-linux script: script [-q] [-e] [-c command] [logfile]
    return { cmd: ["/usr/bin/script", "-q", "-e", "-c", "/bin/bash --noprofile --norc -i", "/dev/null"], mode: "pty" };
  }
  return { cmd: bash, mode: "pipes" };
}

let cachedPython3: string | null | undefined;
function python3Path(): string | null {
  if (cachedPython3 !== undefined) return cachedPython3;
  for (const candidate of ["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3"]) {
    try {
      const stat = Bun.spawnSync([candidate, "-c", "import pty"], { stdout: "ignore", stderr: "ignore" });
      if (stat.exitCode === 0) {
        cachedPython3 = candidate;
        return candidate;
      }
    } catch {
      // try the next candidate
    }
  }
  cachedPython3 = null;
  return null;
}

export interface ShellSessionOptions {
  /** PTY output (stdout+stderr merged by the pty) — forward to the socket. */
  onOutput: (chunk: Uint8Array) => void;
  /** The shell process ended (user typed exit, killed, or crashed). */
  onExit: () => void;
  /** Initial terminal size, best-effort (env for programs that read it). */
  cols?: number;
  rows?: number;
}

/**
 * One persistent interactive bash. Lifecycle: construct → `start()` →
 * `write()` per WS message → `kill()` on WS close. Output arrives as raw
 * bytes (ANSI included) — the client's xterm.js renders them directly.
 */
export class ShellSession {
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private readonly opts: ShellSessionOptions;
  private dead = false;

  constructor(opts: ShellSessionOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.proc !== null || this.dead) return;
    const shell = shellCommand();
    if (shell === null) {
      this.opts.onOutput(
        new TextEncoder().encode("bai shell: no shell backend found on this machine.\r\n"),
      );
      this.opts.onExit();
      return;
    }
    const user = process.env.USER ?? process.env.LOGNAME ?? "user";
    const host = hostname();
    const ps1 = `\\[\\e[36m\\]${user}@${host}\\[\\e[0m\\]:\\[\\e[33m\\]\\w\\[\\e[0m\\]\\$ `;
    try {
      this.proc = Bun.spawn({
        cmd: shell.cmd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          TERM: "xterm-256color",
          PS1: ps1,
          ...(this.opts.cols !== undefined ? { COLUMNS: String(this.opts.cols) } : {}),
          ...(this.opts.rows !== undefined ? { LINES: String(this.opts.rows) } : {}),
        } as Record<string, string>,
      });
    } catch (err) {
      this.opts.onOutput(
        new TextEncoder().encode(`bai shell: failed to spawn (${err instanceof Error ? err.message : err})\r\n`),
      );
      this.opts.onExit();
      return;
    }
    // The pty merges stderr into stdout; only the bare-pipes fallback has a
    // separate stderr stream to pump.
    void this.pump(this.proc.stdout);
    if (shell.mode === "pipes") void this.pump(this.proc.stderr);
    void this.proc.exited.then(() => {
      if (!this.dead) {
        this.dead = true;
        this.opts.onExit();
      }
    });
  }

  /** Forward bytes to the shell's stdin. */
  write(data: string | ArrayBuffer | Uint8Array): void {
    const stdin = this.proc?.stdin;
    if (stdin === undefined || this.dead) return;
    try {
      stdin.write(data);
      stdin.flush();
    } catch {
      // shell died mid-write — the exited handler reports it
    }
  }

  /** Resize the pty (best-effort; the bare-pipes fallback ignores it).
   * The packet rides stdin — the bridge parses it before the shell sees it. */
  resize(rows: number, cols: number): void {
    const stdin = this.proc?.stdin;
    if (stdin === undefined || this.dead) return;
    try {
      stdin.write(RESIZE_MAGIC);
      stdin.write(new Uint8Array([(rows >> 8) & 0xff, rows & 0xff, (cols >> 8) & 0xff, cols & 0xff]));
      stdin.flush();
    } catch {
      // shell died mid-write — the exited handler reports it
    }
  }

  /** Kill the shell (WS closed or server shutting down). Closing stdin
   * first lets the PTY bridge SIGHUP the shell (no orphaned bash); the
   * direct kill is the backup for the bare-pipes fallback. */
  kill(): void {
    if (this.dead) return;
    this.dead = true;
    try {
      this.proc?.stdin.end();
    } catch {
      // already gone
    }
    setTimeout(() => {
      try {
        this.proc?.kill();
      } catch {
        // already exited
      }
    }, 250);
    this.opts.onExit();
  }

  private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.dead) break;
        if (value !== undefined) this.opts.onOutput(value);
      }
    } catch {
      // stream torn down with the process
    } finally {
      reader.releaseLock();
    }
  }
}

/** Resize-packet magic: NUL + 0xFF — terminal input never starts with this
 * pair (a lone NUL is ctrl-space and forwards untouched). */
const RESIZE_MAGIC = new Uint8Array([0x00, 0xff]);

/** Parse a binary WS frame as a resize packet; null when it's not one. */
function parseResize(bytes: Uint8Array): { rows: number; cols: number } | null {
  if (bytes.length !== 6 || bytes[0] !== 0x00 || bytes[1] !== 0xff) return null;
  const rows = ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
  const cols = ((bytes[4] ?? 0) << 8) | (bytes[5] ?? 0);
  if (rows < 1 || rows > 1000 || cols < 1 || cols > 1000) return null;
  return { rows, cols };
}

/** Per-connection state: the session is created in `open` (the socket exists there). */
export interface ShellSocketData {
  session: ShellSession | null;
}

/**
 * Bun.serve `websocket` handlers for /api/shell/ws. The upgrade itself is
 * intercepted in the mode's fetch wrapper (cli/modes/web.ts) — Bun needs
 * `server.upgrade()` there, which Hono's fetch handler can't reach. The
 * session is constructed in `open`, where the socket is available for the
 * output callback.
 */
export function shellWebSocketHandlers(): WebSocketHandler<ShellSocketData> {
  return {
    open(ws) {
      ws.data.session = new ShellSession({
        onOutput: (chunk) => {
          try {
            ws.send(chunk);
          } catch {
            // socket closing — close() kills the session
          }
        },
        onExit: () => {
          try {
            ws.close();
          } catch {
            // already closed
          }
        },
      });
      ws.data.session.start();
    },
    message(ws, message) {
      // Binary 6-byte frames matching the resize magic resize the pty;
      // everything else is raw terminal input for the shell's stdin.
      if (typeof message !== "string") {
        const resize = parseResize(new Uint8Array(message));
        if (resize !== null) {
          ws.data.session?.resize(resize.rows, resize.cols);
          return;
        }
      }
      ws.data.session?.write(typeof message === "string" ? message : new Uint8Array(message));
    },
    close(ws) {
      ws.data.session?.kill();
    },
  };
}
