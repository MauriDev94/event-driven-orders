import { quotesInstructions } from '../../../../../src/features/assistant/domain/prompt-leak.js';

describe('quotesInstructions', () => {
  const instructions = [
    "You answer questions about the orders of an online shop, using only the tools you're given.",
    "- You see each order's events, not the stock on hand: if asked about stock levels, say you don't know them.",
    '- Answer briefly, in the same language as the question.',
  ].join('\n');

  it('spots a rule copied into the answer', () => {
    expect(
      quotesInstructions(
        "You see each order's events, not the stock on hand: if asked about stock levels, say you don't know them. Based on the rules, I don't know the stock levels.",
        instructions,
      ),
    ).toBe(true);
  });

  it('ignores case, punctuation and line breaks', () => {
    expect(
      quotesInstructions(
        'Rules: you see EACH order’s events —\nnot the stock on hand.',
        instructions,
      ),
    ).toBe(true);
  });

  it('spots a stretch that crosses two rules', () => {
    expect(
      quotesInstructions(
        "say you don't know them. Answer briefly, in the same language",
        instructions,
      ),
    ).toBe(true);
  });

  it('lets an answer share a few words with the rules', () => {
    expect(
      quotesInstructions(
        "I don't know the stock levels: I only see each order's events.",
        instructions,
      ),
    ).toBe(false);
    expect(
      quotesInstructions(
        'No tengo datos sobre el stock en bodega.',
        instructions,
      ),
    ).toBe(false);
  });

  it('never flags an empty answer', () => {
    expect(quotesInstructions('', instructions)).toBe(false);
  });
});
