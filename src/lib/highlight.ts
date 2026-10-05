// Whole days elapsed since an RFC3339 timestamp. Used to gate the "New" badge on
// ProductCard against NEW_BADGE_DAYS.
export function daysSince(iso: string, now: Date = new Date()): number {
  return Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
}
