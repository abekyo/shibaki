// Minimal ANSI color helpers. Zero dependencies.
//
// Activation rules (in order):
//   1) NO_COLOR env var present (any value)            → disabled (https://no-color.org/)
//   2) FORCE_COLOR=1 / FORCE_COLOR=true                → enabled (CI pipelines that DO render ANSI)
//   3) Otherwise: enabled iff process.stderr.isTTY === true
//
// Used sparingly — only on status / verdict symbols where color carries semantic
// meaning (red = bad, green = good, yellow = warn). Avoid coloring prose.

function isColorEnabled(): boolean {
  if ("NO_COLOR" in process.env) return false;
  const force = process.env.FORCE_COLOR;
  if (force === "1" || force === "true") return true;
  return !!process.stderr.isTTY;
}

const enabled = isColorEnabled();

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

function wrap(code: string, s: string): string {
  return enabled ? `${ESC}${code}m${s}${RESET}` : s;
}

export const red    = (s: string) => wrap("31", s);
export const green  = (s: string) => wrap("32", s);
export const yellow = (s: string) => wrap("33", s);
export const cyan   = (s: string) => wrap("36", s);
export const dim    = (s: string) => wrap("2", s);
export const bold   = (s: string) => wrap("1", s);
