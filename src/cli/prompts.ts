import { createInterface } from "node:readline/promises";

/** Is the session interactive (a real terminal we can prompt on)? */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Yes/no confirmation. Returns `def` immediately in non-interactive sessions (piped, CI, daemon)
 * so nothing ever blocks. Empty input also returns `def`.
 */
export async function confirm(question: string, opts: { default?: boolean } = {}): Promise<boolean> {
  const def = opts.default ?? true;
  if (!isInteractive()) return def;
  const hint = def ? "[Y/n]" : "[y/N]";
  const answer = (await ask(`${question} ${hint} `)).toLowerCase();
  if (!answer) return def;
  return answer === "y" || answer === "yes";
}

/**
 * Single-choice prompt. Each choice has a `key` (the letter the user types) and a `label`.
 * Returns the first choice's key in non-interactive sessions. Re-asks on invalid input.
 */
export async function choose(
  question: string,
  choices: Array<{ key: string; label: string }>
): Promise<string> {
  if (!isInteractive()) return choices[0]?.key;
  const rendered = choices.map((c) => `[${c.key}]${c.label}`).join(" / ");
  for (;;) {
    const answer = (await ask(`${question}  ${rendered} `)).toLowerCase();
    const match = choices.find((c) => c.key.toLowerCase() === answer);
    if (match) return match.key;
    if (!answer && choices[0]) return choices[0].key;
    console.log(`Please enter one of: ${choices.map((c) => c.key).join(", ")}`);
  }
}
