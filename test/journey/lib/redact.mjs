// Redaction for everything the harness prints or writes: logs, summaries, errors.
// Registered secrets are masked by value; patterns catch what was never registered.
// Pure: takes the home directory and repository root as arguments.
//
// Two levels. The console masks credentials, URLs and every path. Evidence on disk, with
// {keepPaths:true}, masks credentials and the home directory only, so `cwd` and path arguments stay
// readable in summary.json and stream.jsonl.

const MASK = "<redacted>";
const SECRET_KEY_RE = /^(authorization|cookie|.*(?:_|-)?secret|(?:refresh|access|id)_?token|api[_-]?key)$/i;

const variants = (p) => (p ? [...new Set([p, p.replace(/\\/g, "/"), p.replace(/\//g, "\\")])] : []);

export class Redactor {
  constructor({ home = "", repoRoot = "" } = {}) {
    this.secrets = new Set();
    this.home = home;
    this.repoRoot = repoRoot;
  }

  // Register a secret value (token, key). Short values are ignored: they would mangle text.
  add(secret) {
    if (typeof secret === "string" && secret.length >= 8) this.secrets.add(secret);
  }

  text(input, { keepPaths = false } = {}) {
    let out = String(input ?? "");
    for (const s of this.secrets) out = out.split(s).join(MASK);
    out = out.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, MASK);
    out = out.replace(/\bsk-[\w-]{8,}/g, MASK);
    out = out.replace(/Bearer\s+[^\s"']+/gi, `Bearer ${MASK}`);
    out = out.replace(/(refresh_token|access_token|client_secret|api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi, `$1$2${MASK}`);
    if (keepPaths) {
      out = out.replace(/(https?:\/\/)[^\s"'/@]+@/g, `$1${MASK}@`); // credentials in a URL
      for (const v of variants(this.home)) out = out.split(v).join("~");
      return out;
    }
    out = out.replace(/https?:\/\/[^\s"']+/g, "<url>");
    for (const v of variants(this.repoRoot)) out = out.split(v).join("<repository root>");
    for (const v of variants(this.home)) out = out.split(v).join("~");
    out = out.replace(/[A-Za-z]:[\\/][^\s"']+/g, "<path>");
    out = out.replace(/\/(?:home|Users|mnt|root)\/[^\s"']+/g, "<path>");
    return out;
  }

  // Deep copy with every string value redacted (keys are kept). A string held under a key that
  // names a secret is masked whole. Functions and undefined drop out, as in JSON.
  deep(value, opts) {
    if (typeof value === "string") return this.text(value, opts);
    if (Array.isArray(value)) return value.map((v) => this.deep(v, opts));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value)
        .filter(([, v]) => typeof v !== "function")
        .map(([k, v]) => [k, typeof v === "string" && SECRET_KEY_RE.test(k) ? MASK : this.deep(v, opts)]));
    }
    return value;
  }
}
