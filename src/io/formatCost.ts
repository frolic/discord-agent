/**
 * Render a USD amount with adaptive precision: 4 digits below 1¢ so
 * sub-cent calls stay readable, 3 digits above. Used in debug-channel
 * per-call usage suffixes.
 */
export function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(3)}`;
}
