/**
 * Consecutive words an answer has to share with the instructions to count as
 * a copy. A normal answer shares short phrases with them ("don't know",
 * "each order's events"); eight words in a row only show up when the model
 * repeats a rule.
 */
const LEAK_WORDS = 8;

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function stretches(words: string[]): string[] {
  const found: string[] = [];
  for (let start = 0; start + LEAK_WORDS <= words.length; start++) {
    found.push(words.slice(start, start + LEAK_WORDS).join(' '));
  }
  return found;
}

/**
 * Whether the answer repeats a stretch of the system prompt, ignoring case,
 * punctuation and line breaks. It only catches a copy: a rule translated or
 * reworded by the model gets through.
 */
export function quotesInstructions(
  answer: string,
  instructions: string,
): boolean {
  const known = new Set(stretches(wordsOf(instructions)));
  return stretches(wordsOf(answer)).some((stretch) => known.has(stretch));
}
