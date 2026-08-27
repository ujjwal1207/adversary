/**
 * @adversary/report
 *
 * Self-contained static HTML scorecard: single file, inline CSS, no build step,
 * no network, opens from the filesystem.
 *
 * The one thing it may never do is render attack success rate without
 * false-positive cost beside it, at equal weight (docs/ARCHITECTURE.md P4).
 */

export type { ReportInput } from './report.js';
export { renderReport } from './report.js';
