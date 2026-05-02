/**
 * Render a token count as a compact human-readable string with k/M
 * suffixes (`6800` → `6.8k`, `1_250_000` → `1.25M`). Used in debug-channel
 * lines where horizontal space is at a premium.
 */
export function formatTokens(count: number): string {
  // Cutoff is 999_500 (not 1_000_000) so k-tier never has to render a
  // four-digit number — anything that would round up to "1000k" gets
  // promoted to the M tier as "1M" instead.
  if (count >= 999_500) return `${threeSigFigs(count / 1_000_000)}M`;
  if (count >= 1000) return `${threeSigFigs(count / 1000)}k`;
  return `${count}`;
}

/** 3 significant digits across magnitudes, with trailing zeros stripped. */
function threeSigFigs(value: number): string {
  if (value < 10) return parseFloat(value.toFixed(2)).toString();
  if (value < 100) return parseFloat(value.toFixed(1)).toString();
  return value.toFixed(0);
}
