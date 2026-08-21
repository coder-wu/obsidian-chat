import esbuild from "esbuild";
import builtins from "builtin-modules";
import { readFileSync } from "fs";

const prod = process.argv[2] === "production";
// Read manifest so the build fails fast if it is malformed.
JSON.parse(readFileSync("manifest.json", "utf8"));

esbuild
  .build({
    entryPoints: ["src/main.ts"],
    bundle: true,
    // obsidian + electron are provided by the host at runtime; node builtins
    // are left external so the SDKs' optional node code paths don't get pulled
    // into the browser bundle.
    external: ["obsidian", "electron", ...builtins],
    format: "cjs",
    target: "es2022",
    logLevel: "info",
    sourcemap: prod ? false : "inline",
    treeShaking: true,
    outfile: "main.js",
    minify: prod,
    platform: "browser",
    define: {
      "process.env.NODE_ENV": prod ? '"production"' : '"development"',
    },
  })
  .catch(() => process.exit(1));
