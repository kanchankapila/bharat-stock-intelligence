/** Both feeds must explicitly report freshness before the terminal can claim it is live. */
export function intradayFeedsAreLive(
  breadth: { isStale?: boolean } | null | undefined,
  recommendations: { isStale?: boolean } | null | undefined,
  fetchError = false,
): boolean {
  return !fetchError && breadth?.isStale === false && recommendations?.isStale === false;
}
