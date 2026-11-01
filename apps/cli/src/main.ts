#!/usr/bin/env node
// Hook invocations avoid loading the normal CLI and its dependency graph.
if (process.argv[2] === "hook") await import(new URL("../bin/hook.mjs", import.meta.url).href);
else await import("./commands.js");
export {};
