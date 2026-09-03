import { parseCliArgs, usage, UsageError } from "./args";
import { boot, VERSION, type Booted } from "./boot";
import { runHost, runWeb } from "./modes/web";
import { runOneShot } from "./modes/oneshot";
import { runTui } from "./modes/tui";

async function main(): Promise<number> {
  let args;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`bai: ${err.message}\n\n${usage()}`);
      return 2;
    }
    throw err;
  }

  if (args.version) {
    console.log(`bai ${VERSION}`);
    return 0;
  }
  if (args.help) {
    console.log(usage());
    return 0;
  }

  const booted: Booted = await boot(args);
  switch (args.mode) {
    case "tui":
      await runTui(booted);
      return 0;
    case "web":
      await runWeb(booted, { open: args.open });
      return 0;
    case "host":
      await runHost(booted);
      return 0;
    case "oneshot":
      return runOneShot(booted, {
        prompt: args.prompt as string,
        format: args.format,
        continueLast: args.continueLast,
        ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
      });
  }
}

process.exitCode = 1;
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`bai: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exitCode = 1;
  });
