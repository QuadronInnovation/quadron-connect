// Per-attempt evidence under --out: <row>-<model>-<time>/ with stream.jsonl and summary.json.
// Credentials and the home directory are masked before anything is written, paths and URLs stay
// readable for whoever reads the evidence, and nothing is ever overwritten: the directory is
// created without `recursive` and files with the exclusive flag. A failure is remembered in
// `failed`, and the run ends with exit 3 and no PASS.

import path from "node:path";

const safeName = (s) => String(s).replace(/[^\w.-]+/g, "_");
const stamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, "-");
const MAX_TRIES = 1000;

// A new directory, never one that exists.
export function newUniqueDir(parent, base, fs) {
  for (let i = 0; i < MAX_TRIES; i++) {
    const dir = path.join(parent, i ? `${base}-${i}` : base);
    try { fs.mkdirSync(dir); return dir; } catch (e) { if (e?.code !== "EEXIST") throw e; }
  }
  throw new Error("no free directory name");
}

export class Evidence {
  constructor({ out, row, model, now, fs, red }) {
    this.fs = fs;
    this.red = red;
    this.failed = false;
    this.name = `${safeName(row)}-${safeName(model)}-${stamp(now)}`;
    fs.mkdirSync(out, { recursive: true });
    this.dir = newUniqueDir(out, this.name, fs);
    this.streamFile = path.join(this.dir, "stream.jsonl");
    fs.writeFileSync(this.streamFile, "", { flag: "wx" });
  }

  message(m) {
    try { this.fs.appendFileSync(this.streamFile, `${JSON.stringify(this.red.deep(m, { keepPaths: true }))}\n`); } catch { this.failed = true; }
  }

  summary(s) {
    const safe = this.red.deep(s, { keepPaths: true });
    try { this.fs.writeFileSync(path.join(this.dir, "summary.json"), JSON.stringify(safe, null, 2), { flag: "wx" }); } catch { this.failed = true; }
    return safe;
  }
}
