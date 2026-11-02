import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  pack: {
    dts: {
      tsgo: true,
    },
    exports: {
      devExports: true,
    },
    format: ["esm", "cjs"],
    sourcemap: true,
    entry: ["src/index.ts"],
  },
  lint: {
    ignorePatterns: ["*.astro"],
    options: {
      typeAware: true,
      typeCheck: false, // TODO switch back
    },
  },
  fmt: {},
  test: {
    typecheck: {
      enabled: true,
      include: ["tests/**/*.test-d.ts"],
      tsconfig: "./tsconfig.test.json",
      checker: "tsgo",
    },
  },
});
