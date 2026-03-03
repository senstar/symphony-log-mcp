// Entry point for Symphony Log MCP Server
import { main } from "./server";
main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
