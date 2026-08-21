// Rough token estimator. We avoid shipping a real tokenizer (heavy, and each
// provider tokenizes differently). chars/4 is a decent ballpark that lets the
// user judge cost before sending. Always labeled "approx." in the UI.

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
