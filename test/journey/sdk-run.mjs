#!/usr/bin/env node
// Thin entry: all behaviour is in lib/main.mjs. Dry unless --live is passed.
import { main } from "./lib/main.mjs";

const r = await main({ argv: process.argv.slice(2), env: process.env, fetch: globalThis.fetch });
process.exit(r.exitCode);
