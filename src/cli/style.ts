// Minimal ANSI styling for user-facing CLI output. No-ops when not a TTY or NO_COLOR is set.
const enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);

export const bold = wrap("1");
export const dim = wrap("2");
export const cyan = wrap("36");
export const green = wrap("32");
export const magenta = wrap("35");
export const yellow = wrap("33");
