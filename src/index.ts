#!/usr/bin/env node
import { main } from "./server.js";

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

// Keep the process alive when stdin closes (VS Code may close the pipe
// during idle periods).  Without this, Node drains the event loop and
// exits — sometimes with code 1 due to a late stdout EPIPE.
process.stdin.on("end", () => {
  console.error("stdin closed, exiting gracefully");
  process.exit(0);
});

// Prevent EPIPE crashes when writing to stdout after the parent closes
// the pipe.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") {
    process.exit(0);
  }
  console.error("stdout error:", err);
});

// Diagnostic: log the exit code so it appears in VS Code's MCP output.
process.on("exit", (code) => {
  if (code !== 0) {
    console.error(`Process exiting with code ${code}`);
  }
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
