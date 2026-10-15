/**
 * Bounding what a tool hands the model.
 *
 * Here rather than in each plugin because a plugin cannot share code with a
 * sibling: `@dynamicagents/plugins` fails any subpath whose module graph reaches
 * another plugin's directory, so installing one capability never drags in
 * another's. The only home two plugins can both reach is this package, and
 * without it the same function is copied per plugin and the copies drift.
 */

/**
 * Middle-out truncation, so both the first error and the final summary survive.
 *
 * The guard is not defensive padding. Without it a `max` at or below the marker's
 * own length makes `half` zero or negative, and `slice(-0)` is `slice(0)` — the
 * *whole* string — so the function returns more than it was given: 500 characters
 * in, 543 out at `max: 80`. A silent inversion of the one thing it does,
 * reachable from a public config field.
 *
 * Characters, not bytes: the budget is `String.length`, so a caller whose ceiling
 * is really a byte count has to convert.
 */
export function truncateOutput(text: string, max: number): string {
  if (text.length <= max) return text;

  const marker = (dropped: number) =>
    `\n\n… [${dropped} characters omitted from the middle] …\n\n`;

  // No budget for two halves plus the marker: keep the head, which is where the
  // first error is, and say nothing clever.
  const half = Math.floor((max - marker(text.length).length) / 2);
  if (half < 1) return text.slice(0, Math.max(0, max));

  return (
    text.slice(0, half) + marker(text.length - half * 2) + text.slice(-half)
  );
}
