import { spawn } from "node:child_process";
import net from "node:net";
import type { CAC } from "cac";
import * as ansi from "picocolors";
import { isSingleFileExecutable } from "../bundle.ts";
import {
  connectToCliDaemon,
  defaultCliDaemonSession,
  runCliDaemon,
  socketPathForCliDaemonSession,
  waitForCliDaemon,
} from "./cliBrowserDaemon.ts";

const START_TIMEOUT_MS = 15000;

export const CliBrowserCommand = {
  name: "cli",
  description: "Control browser sessions from the command line",

  register(cli: CAC): void {
    cli
      .command("cli [...args]", "Control browser sessions from the command line")
      .option("-s, --session <name>", "Name of the browser session", {
        default: defaultCliDaemonSession,
      })
      .option(
        "--browser <name>",
        "Browser to use (chromium, firefox, webkit)",
        {
          default: "chromium",
        },
      )
      .option("--headless", "Run browser in headless mode", { default: false })
      .action(async (args, options) => {
        if (args.length === 0) {
          console.error(`${ansi.red("Error:")} No subcommand provided`);
          console.log(`${ansi.blue("Help:")}\n`);
          cli.outputHelp();
          process.exit(1);
        }

        const sub = args[0];
        const subArgs = args.slice(1);

        if (sub === "start") {
          await start({
            session: options.session,
            browser: options.browser,
            headless: options.headless,
          });
        } else if (sub === "do") {
          if (subArgs.length === 0) {
            console.error(`${ansi.red("Error:")} No goal provided`);
            process.exit(1);
          }
          await runGoal(subArgs, options.session);
        } else {
          console.error(
            `${ansi.red("Error:")} Incorrect '${sub}' command, use one of: start, do\n`,
          );
          console.log(`${ansi.blue("Help:")}\n`);
          cli.outputHelp();
          process.exit(1);
        }
      });
  },
};

interface StartOptions {
  session: string;
  browser: string;
  headless: boolean;
}


async function start(options: StartOptions): Promise<void> {
  if (process.env.ALUMNIUM_CLI_DAEMONIZE === "1") {
    await runCliDaemon({
      session: options.session,
      browser: options.browser,
      headless: options.headless,
    });
    return;
  }

  const socketPath = socketPathForCliDaemonSession(options.session);
  if (await canConnect(socketPath)) {
    console.log(`Browser daemon is already running at ${socketPath}`);
    return;
  }

  const child = spawn(process.execPath, childArgs(), {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      ALUMNIUM_CLI_DAEMONIZE: "1",
    },
  });
  child.unref();

  const ready = await waitForCliDaemon(options.session, START_TIMEOUT_MS);
  if (!ready) {
    console.error(
      `${ansi.red("Error:")} Browser daemon did not become ready within ${START_TIMEOUT_MS}ms`,
    );
    process.exit(1);
  }

  console.log(`Started browser daemon ${child.pid} at ${socketPath}`);
}

async function runGoal(goalParts: string[], session: string): Promise<void> {
  const text = goalParts.join(" ").trim();
  const connection = await connectToCliDaemon(session);
  const response = await connection.send("do", { goal: text });
  connection.close();

  if (response.error) {
    console.error(`${ansi.red("Error:")} ${response.error}`);
    process.exit(1);
  }

  if (response.result) console.log(response.result);
}

function childArgs(): string[] {
  return process.argv.slice(isSingleFileExecutable() ? 2 : 1);
}

async function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
}
