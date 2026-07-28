/**
 * Result of validating a provider's raw candidate inventory.
 *
 * `rawCount` keeps a genuine title miss distinct from a provider that returned
 * dead/poison candidates. The circuit may treat the former as healthy without
 * treating the latter as a success.
 */
export interface VerifiedProviderInventory<T> {
  rawCount: number;
  playable: T[];
}

export function verifiedInventoryIsHealthy<T>(
  result: VerifiedProviderInventory<T>,
  options: { emptyIsTitleMiss: boolean }
): boolean {
  if (result.playable.length > 0) return true;
  return options.emptyIsTitleMiss && result.rawCount === 0;
}
