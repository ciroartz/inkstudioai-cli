#!/usr/bin/env node
import { main, systemIo } from "../src/cli.js";

process.on("SIGINT", () => {
  // Show the cursor again if a spinner hid it.
  if (process.stderr.isTTY) process.stderr.write("\r\x1b[2K\x1b[?25h");
  process.exit(130);
});

process.exitCode = await main(process.argv.slice(2), systemIo());
