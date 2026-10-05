import { cac } from "cac";
import * as ansi from "picocolors";
import { ALUMNIUM_BIN_VERSION } from "../package.ts";
import { setupEmbeddedDependencies } from "../standalone/setupEmbeddedDependencies.ts";

// NOTE: Don't use logger here, so it can be configured by commands before any
// log is emitted. It allows to avoid re-configuration complexity when using
// `getLogger` in module scope.

await main();

async function main() {
  await setupEmbeddedDependencies();

  const [
    { McpCommand },
    { ServerCommand },
    { CliSessionCommand, runCliSession },
  ] = await Promise.all([
    import("../mcp/McpCommand.ts"),
    import("../server/ServerCommand.ts"),
    import("./CliSessionCommand.ts"),
  ]);

  // NOTE: cac only matches single-word commands, so `alumnium cli <command>`
  // is parsed by its own parser.
  if (Bun.argv[2] === CliSessionCommand.name)
    return runCliSession(Bun.argv.slice(3));

  const COMMANDS = [ServerCommand, McpCommand, CliSessionCommand];
  const cli = cac("alumnium");

  COMMANDS.forEach((command) => command.register(cli));

  cli.help();
  cli.version(ALUMNIUM_BIN_VERSION);

  cli.addEventListener("command:*", () => {
    const invalidCommand = cli.args[0];
    const commandNames = COMMANDS.map((command) => command.name).join(", ");
    // NOTE: We intentionally use `console` here to format it independently. Also,
    // see a NOTE on the top.
    console.error(
      `${ansi.red("Error:")} Incorrect '${invalidCommand}' command, use one of: ${commandNames}\n`,
    );
    console.log(`${ansi.blue("Help:")}\n`);
    cli.outputHelp();
    process.exit(1);
  });

  if (Bun.argv.length <= 2) {
    cli.outputHelp();
    process.exit(1);
  }

  cli.parse(Bun.argv);
}
