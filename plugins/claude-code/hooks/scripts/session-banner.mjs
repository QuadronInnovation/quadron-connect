#!/usr/bin/env node
// SessionStart hook. Prints one static reminder line; plain stdout from SessionStart is added
// to the session context. No network, no file reads, no credentials. It deliberately does not
// print the "Quadron is connected" sentence: that sentence comes only from the CLI-installed
// hook, which lists the person's projects, and SKILL.md treats it as proof that hook ran.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CAPTURE_RULE } from './capture-rule.mjs';

export const BANNER =
  `Quadron hooks are active. If quad_* tools are present: when the person reaches back to their prior work, call quad_context with the topic (or quad_recall inside a project) before answering, unless the session already lists what they ask for. When they state a decision, standard or preference: ${CAPTURE_RULE}`;

export const OUTPUT = `${BANNER}\n`;

function isMain() {
  try {
    return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  process.stdout.write(OUTPUT);
}
