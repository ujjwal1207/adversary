/**
 * Normalisation, the whole basis of taint matching.
 *
 * The claim in docs/ARCHITECTURE.md 10 is that matching "must survive
 * paraphrase": the agent may restate an account identifier rather than copying
 * it verbatim. This module is how, and its limits are the limits of the claim.
 *
 * There is no semantic matching here and there must not be. Adding a language
 * model to close the remaining gap would reintroduce exactly the shared failure
 * mode P1 exists to prevent - the provenance detector and the agent would be the
 * same kind of thing, failing on the same inputs, at the same time, silently.
 * An untraceable value is a documented limitation, not a reason to add a model.
 */

/**
 * Normalises an identifier for comparison.
 *
 * NFKC first, so full-width and compatibility characters fold to their ASCII
 * equivalents; then case folding; then every separator a human or a model might
 * introduce is stripped. `acct_vendor_acme_new`, `ACCT VENDOR ACME NEW` and
 * `Acct-Vendor-Acme-New` all become `acctvendoracmenew`.
 */
export function normalizeIdentifier(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_.,:;/\\()[\]{}'"`]/g, '')
    .trim();
}

/**
 * Every numeric reading of a written amount, in paise.
 *
 * A payload saying "4,800" is ambiguous: an agent may pass 4800 (reading it as
 * paise) or 480000 (converting rupees correctly). Corpus family A3 tests whether
 * the agent gets that right - so the *matcher* must not be fooled by the same
 * confusion, or the scenario would end up measuring the harness.
 *
 * The unit variants are deliberately generous. A false positive here escalates
 * an action for human review; a false negative lets a redirected payment through
 * untraced. Those costs are not symmetric.
 */
export function amountCandidates(value: number): number[] {
  if (!Number.isFinite(value)) return [];

  const candidates = new Set<number>();
  const add = (n: number): void => {
    if (Number.isInteger(n) && n >= 0 && Number.isSafeInteger(n)) candidates.add(n);
  };

  add(value);
  add(value * 100); // written in rupees, matched against paise
  add(value / 100); // written in paise, matched against rupees

  return [...candidates].sort((a, b) => a - b);
}

/**
 * Parses a written amount into its face value, without floating-point
 * arithmetic on the fractional part.
 *
 * Returns the value *as written* - "4,800.50" is 4800.5 - and leaves the unit
 * question to `amountCandidates`. Deciding here would be guessing.
 */
export function parseWrittenAmount(text: string): number | null {
  const cleaned = text.replace(/[₹$€£\s]/g, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;

  const [whole, fraction = ''] = cleaned.split('.');
  const scaled = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return scaled / 100;
}
