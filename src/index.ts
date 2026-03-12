#!/usr/bin/env node
import { main } from "./server.js";

function ts(): string {
  return new Date().toISOString();
}

process.on("uncaughtException", (err) => {
  console.error(`[${ts()}] uncaughtException:`, err);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[${ts()}] unhandledRejection:`, reason);
});

// VS Code's MCP host closes the stdin pipe during idle periods, window
// reloads, or when it decides to recycle the server.  Without a ref'd
// handle keeping the event loop alive, Node drains and exits — which
// VS Code interprets as a crash and shows "server died".
//
// Strategy: keep a ref'd interval alive so the process survives stdin
// close.  The stdout EPIPE handler below will still cleanly exit if
// VS Code truly disconnects the output pipe.
process.stdin.on("end", () => {
  console.error(`[${ts()}] stdin closed — keeping process alive`);
  setInterval(() => {}, 60_000);  // ref'd: prevents event-loop drain
});

// Prevent EPIPE crashes when writing to stdout after the parent closes
// the pipe.  This is the real "time to die" signal — VS Code has
// disconnected the output pipe, so there's nothing we can send to.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") {
    console.error(`[${ts()}] stdout ${err.code} — exiting`);
    process.exit(0);
  }
  console.error(`[${ts()}] stdout error:`, err);
});

// Log the exit code so it appears in VS Code's MCP output channel.
process.on("exit", (code) => {
  if (code !== 0) {
    console.error(`[${ts()}] process exiting with code ${code}`);
  }
});

// Heartbeat: log RSS every 60s to detect memory leaks and to show
// the last-alive timestamp in the MCP output channel.
setInterval(() => {
  const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
  console.error(`[${ts()}] heartbeat rss=${rss}MB`);
}, 60_000).unref();

main().catch((err) => {
  console.error(`[${ts()}] Fatal error:`, err);
  process.exit(1);
});
