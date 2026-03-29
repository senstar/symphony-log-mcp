import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^(\.{1,2}\/.*)\.js$/,
        replacement: "$1.ts",
      },
    ],
  },
  test: {
    root: ".",
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
