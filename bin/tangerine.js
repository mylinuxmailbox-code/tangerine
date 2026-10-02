#!/usr/bin/env node
// Thin launcher: the TypeScript sources compile to dist/ (npm run build).
import("../dist/src/index.js").catch((e) => {
  if (e && e.code === "ERR_MODULE_NOT_FOUND" && String(e.message).includes("dist/src/index.js")) {
    process.stderr.write("tangerine: not built yet. Run `npm install && npm run build` first.\n");
  } else {
    process.stderr.write(String(e && e.stack ? e.stack : e) + "\n");
  }
  process.exitCode = 1;
});
