import { dialListener } from "@bai/api/client";
import type { Event } from "@bai/shared";
import type { Booted } from "../boot";

const ONE_SHOT_TIMEOUT_MS = 120_000;

/**
 * `bai --one-shot "prompt"` — headless run:
 * subscribe to the session stream BEFORE prompting, submit, print events as
 * NDJSON (or text deltas), exit when the run goes idle.
 */
export async function runOneShot(booted: Booted, opts: { prompt: string; format: "json" | "text"; continueLast: boolean; sessionId?: string }): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: booted.app.fetch });
  // Bun always assigns a real port for TCP listeners (typed optional for Unix sockets).
  const client = dialListener(server.port ?? 0, booted.token);
  let sawFinished = false;
  try {
    const session = await resolveSession(client, opts);
    const ctrl = new AbortController();

    const done = (async () => {
      for await (const evt of client.sessionEvents(session.id, { after: 0, signal: ctrl.signal })) {
        printEvent(evt, opts.format);
        if (evt.type === "run.finished") {
          sawFinished = true;
          break;
        }
      }
    })();

    await client.submitPrompt(session.id, { text: opts.prompt });
    await Promise.race([
      done,
      new Promise((r) => setTimeout(r, ONE_SHOT_TIMEOUT_MS)),
    ]);
    ctrl.abort();
  } finally {
    await Promise.race([server.stop(true), new Promise((r) => setTimeout(r, 2000))]);
    await booted.stop();
    // Headless mode is done — exit explicitly (stray handles must not hang the CLI).
    process.exit(sawFinished ? 0 : 1);
  }
}

async function resolveSession(
  client: Awaited<ReturnType<typeof dialListener>>,
  opts: { continueLast: boolean; sessionId?: string },
) {
  if (opts.sessionId !== undefined) {
    const existing = await client.getSession(opts.sessionId);
    if (existing === undefined) throw new Error(`session not found: ${opts.sessionId}`);
    return existing;
  }
  const sessions = await client.listSessions(1, 0);
  if (opts.continueLast && sessions.length > 0) return sessions[0] as NonNullable<typeof sessions[number]>;
  return client.createSession({ workbench: "chat", oneshot: true });
}

function printEvent(evt: Event, format: "json" | "text"): void {
  if (format === "json") {
    console.log(
      JSON.stringify({
        type: evt.type,
        timestamp: evt.ts,
        sessionId: evt.sessionId,
        seq: evt.seq,
        payload: evt.payload,
      }),
    );
    return;
  }
  if (evt.type === "message.part.delta") {
    const payload = evt.payload as { delta?: string };
    process.stdout.write(payload.delta ?? "");
  } else if (evt.type === "run.finished") {
    process.stdout.write("\n");
  }
}
