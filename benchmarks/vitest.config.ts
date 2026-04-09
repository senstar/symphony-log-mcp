import { defineConfig } from "vitest/config";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    root: resolve(__dirname, ".."),
    include: ["benchmarks/**/*.bench.ts"],
    testTimeout: 30_000,
  },
});
