/**
 * Pass text through as a single section. The send tool rejects >1900
 * chars upstream, so splitting is the model's responsibility.
 */
export function splitForDelivery(text: string): string[] {
  const trimmed = text.trim();
  return trimmed.length > 0 ? [trimmed] : [];
}
