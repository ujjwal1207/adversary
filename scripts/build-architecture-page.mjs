/**
 * Renders docs/ARCHITECTURE.md as a standalone HTML page.
 *
 *   node scripts/build-architecture-page.mjs [out.html]
 *
 * A script rather than a one-off conversion, because the failure mode here is
 * staleness: the published page drifted from the document once already, and a
 * hand-converted copy guarantees it happens again. This way regenerating is one
 * command and nobody has to decide whether it is worth the effort.
 *
 * The markdown subset is hand-rolled and covers exactly what the document uses
 * - headings, GFM tables, fenced code, mermaid, blockquotes, lists, rules, and
 * inline links/code/emphasis. No dependency, for the same reason the invariant
 * evaluator has none: a converter nobody understands is a converter nobody can
 * debug when the output is wrong in a way that only shows up in one section.
 *
 * Heading ids use GitHub's slug rules, so the document's own cross-references
 * (`#133-dashboard-appsdashboard`) resolve without rewriting a single link.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = resolve(ROOT, 'docs/ARCHITECTURE.md');
const OUT = resolve(process.cwd(), process.argv[2] ?? 'architecture.html');

// --- inline -----------------------------------------------------------------

const escape = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Inline markup.
 *
 * Code spans are lifted out first and put back last. Without that, a generic
 * like `Promise<void>` inside backticks gets its underscores and asterisks
 * treated as emphasis, and a table cell reading `**` stops being a table cell.
 */
function inline(text) {
  // Split on code spans and mark up only the segments between them.
  //
  // No placeholder scheme. A sentinel has to be a character that cannot occur
  // in the source, and choosing one badly corrupts prose silently rather than
  // failing loudly - an earlier version parked spans as " 3 " and restored them
  // with / (\d+) /g, which also matches a bare number in a sentence. Splitting
  // on the delimiter needs no sentinel at all, so there is nothing to get
  // wrong. Safe here because no link label in the document contains a backtick.
  return text
    .split(/(`[^`]+`)/)
    .map((part, i) =>
      i % 2 === 1 ? `<code>${escape(part.slice(1, -1))}</code>` : markup(escape(part)),
    )
    .join('');
}

function markup(s) {
  return s
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
      const external = /^https?:/.test(href);
      const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a href="${href}"${attrs}>${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
}

/** GitHub's heading slugs, so the document's own anchors keep working. */
const slug = (text) =>
  text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s/g, '-');

/** Strips markdown from a heading so it can go in the table of contents. */
const plain = (text) => text.replace(/`/g, '').replace(/\*\*/g, '');

// --- block ------------------------------------------------------------------

function render(markdown) {
  const lines = markdown.split(/\r?\n/);
  const out = [];
  const toc = [];
  let i = 0;

  const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);

  while (i < lines.length) {
    const line = lines[i];

    // fenced code, including mermaid
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i += 1;

      out.push(
        lang === 'mermaid'
          ? `<div class="diagram"><pre class="mermaid">${escape(body.join('\n'))}</pre></div>`
          : `<div class="code"><pre><code data-lang="${escape(lang)}">${escape(
              body.join('\n'),
            )}</code></pre></div>`,
      );
      continue;
    }

    // headings
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      const id = slug(text);
      if (level === 2 || level === 3) toc.push({ level, id, text: plain(text) });
      out.push(
        level === 1
          ? `<h1>${inline(text)}</h1>`
          : `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section">#</a>${inline(
              text,
            )}</h${level}>`,
      );
      i += 1;
      continue;
    }

    // horizontal rule
    if (/^---+\s*$/.test(line)) {
      out.push('<hr />');
      i += 1;
      continue;
    }

    // tables
    if (isTableRow(line) && isTableRow(lines[i + 1] ?? '') && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const cells = (row) =>
        row
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());

      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && isTableRow(lines[i])) body.push(cells(lines[i++]));

      out.push(
        `<div class="scroller"><table><thead><tr>${head
          .map((c) => `<th>${inline(c)}</th>`)
          .join('')}</tr></thead><tbody>${body
          .map((row) => `<tr>${row.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }

    // blockquotes
    if (line.startsWith('>')) {
      const body = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        body.push(lines[i++].replace(/^>\s?/, ''));
      }
      out.push(`<blockquote>${inline(body.join(' ').trim())}</blockquote>`);
      continue;
    }

    // lists
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const ordered = /^(\d+)\.\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      const tag = bullet ? 'ul' : 'ol';
      const items = [];
      while (i < lines.length) {
        const m = bullet ? /^[-*]\s+(.*)$/.exec(lines[i]) : /^(\d+)\.\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        const parts = [bullet ? m[1] : m[2]];
        i += 1;
        // continuation lines, indented under the item
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*\d]/.test(lines[i])) {
          parts.push(lines[i++].trim());
        }
        items.push(`<li>${inline(parts.join(' '))}</li>`);
      }
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    // paragraphs
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('#') &&
      !lines[i].startsWith('```') &&
      !lines[i].startsWith('>') &&
      !/^---+\s*$/.test(lines[i]) &&
      !/^[-*]\s/.test(lines[i]) &&
      !/^\d+\.\s/.test(lines[i]) &&
      !isTableRow(lines[i])
    ) {
      para.push(lines[i++]);
    }
    if (para.length > 0) out.push(`<p>${inline(para.join(' '))}</p>`);
  }

  return { html: out.join('\n'), toc };
}

// --- page -------------------------------------------------------------------

const markdown = readFileSync(SOURCE, 'utf8');
const { html, toc } = render(markdown);

const tocHtml = toc
  .map(
    (entry) =>
      `<a class="toc-link toc-l${entry.level}" href="#${entry.id}">${escape(entry.text)}</a>`,
  )
  .join('');

const page = `<title>Adversary Architecture</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  rel="stylesheet"
  href="https://fonts.googleapis.com/css2?family=Spectral:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"
/>
<style>
:root {
  --ground: #fbfbfd;
  --panel: #f2f4f8;
  --panel-2: #e9ecf2;
  --ink: #14171d;
  --muted: #59616f;
  --faint: #838c9b;
  --rule: #e0e4ea;
  --accent: #2c4a7c;
  --accent-soft: #e9eff8;
  --shadow: 0 1px 2px rgb(20 23 29 / 0.05);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    --ground: #0e1116;
    --panel: #161a21;
    --panel-2: #1d222b;
    --ink: #e5e9ef;
    --muted: #98a1af;
    --faint: #6f7889;
    --rule: #232935;
    --accent: #93b6ea;
    --accent-soft: #16202f;
    --shadow: 0 1px 2px rgb(0 0 0 / 0.4);
  }
}
:root[data-theme='dark'] {
  --ground: #0e1116;
  --panel: #161a21;
  --panel-2: #1d222b;
  --ink: #e5e9ef;
  --muted: #98a1af;
  --faint: #6f7889;
  --rule: #232935;
  --accent: #93b6ea;
  --accent-soft: #16202f;
  --shadow: 0 1px 2px rgb(0 0 0 / 0.4);
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: 'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, sans-serif;
  font-size: 16px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
}

.shell {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0;
  max-width: 1180px;
  margin: 0 auto;
  padding: 0 24px 96px;
}
@media (min-width: 1000px) {
  .shell { grid-template-columns: 232px minmax(0, 1fr); gap: 56px; }
}

/* --- masthead ------------------------------------------------------------ */

.masthead {
  grid-column: 1 / -1;
  padding: 64px 0 32px;
  border-bottom: 1px solid var(--rule);
  margin-bottom: 40px;
}
.eyebrow {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--faint);
  margin: 0 0 14px;
}
.masthead h1 {
  font-family: Spectral, ui-serif, Georgia, serif;
  font-weight: 600;
  font-size: clamp(34px, 5vw, 52px);
  line-height: 1.1;
  letter-spacing: -0.015em;
  margin: 0 0 16px;
  text-wrap: balance;
}
.standfirst {
  font-size: 18px;
  line-height: 1.6;
  color: var(--muted);
  max-width: 62ch;
  margin: 0;
}
.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 28px;
  margin-top: 28px;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.facts b { color: var(--ink); font-weight: 500; }

/* --- contents ------------------------------------------------------------ */

.contents { grid-column: 1 / -1; margin-bottom: 32px; }
.contents summary {
  cursor: pointer;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 12px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
  padding: 10px 0;
}
@media (min-width: 1000px) {
  .contents {
    grid-column: 1;
    grid-row: 2;
    position: sticky;
    top: 24px;
    align-self: start;
    max-height: calc(100vh - 48px);
    overflow-y: auto;
    margin-bottom: 0;
    padding-right: 8px;
  }
  .contents summary { display: none; }
  .contents .toc-body { display: block !important; }
}
.toc-body { display: flex; flex-direction: column; padding: 4px 0 12px; }
.toc-link {
  color: var(--muted);
  text-decoration: none;
  font-size: 13px;
  line-height: 1.4;
  padding: 4px 0 4px 11px;
  border-left: 2px solid transparent;
  transition: color 0.12s, border-color 0.12s;
}
.toc-l3 { padding-left: 24px; font-size: 12.5px; color: var(--faint); }
.toc-link:hover { color: var(--ink); }
.toc-link.here { color: var(--accent); border-left-color: var(--accent); font-weight: 500; }

/* --- prose --------------------------------------------------------------- */

main { grid-column: 1 / -1; min-width: 0; }
@media (min-width: 1000px) { main { grid-column: 2; grid-row: 2; } }

main > h1 { display: none; }

main h2, main h3, main h4 {
  font-family: Spectral, ui-serif, Georgia, serif;
  font-weight: 600;
  letter-spacing: -0.01em;
  text-wrap: balance;
  scroll-margin-top: 24px;
  position: relative;
}
main h2 {
  font-size: 30px;
  line-height: 1.2;
  margin: 64px 0 18px;
  padding-top: 30px;
  border-top: 1px solid var(--rule);
}
main h3 { font-size: 21px; line-height: 1.3; margin: 44px 0 12px; }
main h4 { font-size: 17px; margin: 32px 0 10px; }

.anchor {
  position: absolute;
  left: -22px;
  color: var(--rule);
  text-decoration: none;
  font-family: 'IBM Plex Mono', monospace;
  font-weight: 400;
  opacity: 0;
  transition: opacity 0.12s;
}
h2:hover .anchor, h3:hover .anchor, h4:hover .anchor, .anchor:focus { opacity: 1; }
.anchor:hover { color: var(--accent); }

main p { max-width: 68ch; margin: 0 0 18px; }
main ul, main ol { max-width: 68ch; margin: 0 0 18px; padding-left: 22px; }
main li { margin-bottom: 7px; }
main li::marker { color: var(--faint); }

a { color: var(--accent); text-decoration-color: color-mix(in srgb, var(--accent) 35%, transparent); text-underline-offset: 2px; }
a:hover { text-decoration-color: currentColor; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }

strong { font-weight: 600; }
hr { border: 0; height: 0; margin: 0; }

code {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.855em;
  background: var(--panel);
  border: 1px solid var(--rule);
  border-radius: 3px;
  padding: 0.1em 0.34em;
  word-break: break-word;
}

.code, .diagram, .scroller { margin: 0 0 22px; overflow-x: auto; }
.code {
  background: var(--panel);
  border: 1px solid var(--rule);
  border-radius: 6px;
}
.code pre { margin: 0; padding: 16px 18px; }
.code code {
  background: none;
  border: 0;
  padding: 0;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre;
  color: var(--ink);
}
.diagram {
  background: var(--panel);
  border: 1px solid var(--rule);
  border-radius: 6px;
  padding: 20px;
  text-align: center;
}
.diagram pre { margin: 0; }

table {
  border-collapse: collapse;
  width: 100%;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
th, td {
  text-align: left;
  vertical-align: top;
  padding: 9px 14px 9px 0;
  border-bottom: 1px solid var(--rule);
}
th {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--faint);
  border-bottom-color: var(--ink);
  white-space: nowrap;
}
tbody tr:last-child td { border-bottom: 0; }
td code { font-size: 12.5px; }

blockquote {
  margin: 0 0 22px;
  padding: 14px 18px;
  border-left: 3px solid var(--accent);
  background: var(--accent-soft);
  border-radius: 0 5px 5px 0;
  color: var(--muted);
  max-width: 68ch;
}
blockquote code { background: var(--panel-2); }



footer {
  grid-column: 1 / -1;
  margin-top: 72px;
  padding-top: 22px;
  border-top: 1px solid var(--rule);
  font-size: 13px;
  color: var(--faint);
  max-width: 68ch;
}

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
</style>

<div class="shell">
  <header class="masthead">
    <p class="eyebrow">Design contract</p>
    <h1>Adversary</h1>
    <p class="standfirst">
      The architecture of an evaluation and red-team harness for AI agents that
      have payment authority. This document is the contract the implementation
      satisfies: where the build spec left a decision open, this closes it and
      records the reasoning.
    </p>
    <div class="facts">
      <span><b>62</b> scenarios, families A&ndash;G</span>
      <span><b>957</b> tests</span>
      <span><b>8</b> deterministic gate rules</span>
      <span><b>20</b> recorded deviations</span>
    </div>
  </header>

  <details class="contents" open>
    <summary>Contents</summary>
    <nav class="toc-body">${tocHtml}</nav>
  </details>

  <main>
${html}
  </main>

  <footer>
    Generated from <code>docs/ARCHITECTURE.md</code> by
    <code>scripts/build-architecture-page.mjs</code>. Every figure quoted here is
    measured against the mock rail with the reference scripted agent; see
    <code>docs/LIMITATIONS.md</code> for what this build has not verified.
  </footer>
</div>

<script>
  // Scroll-spy over the contents. Plain IntersectionObserver: the page is one
  // long document and the reader's position in it is the only state there is.
  const links = new Map(
    [...document.querySelectorAll('.toc-link')].map((a) => [a.getAttribute('href').slice(1), a]),
  );
  const seen = new Set();

  const mark = () => {
    let current = null;
    for (const [id, link] of links) if (seen.has(id)) current = link;
    for (const link of links.values()) link.classList.remove('here');
    if (current) current.classList.add('here');
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) seen.add(entry.target.id);
        else seen.delete(entry.target.id);
      }
      mark();
    },
    { rootMargin: '0px 0px -70% 0px' },
  );

  for (const id of links.keys()) {
    const el = document.getElementById(id);
    if (el) observer.observe(el);
  }

  // The contents list starts closed on narrow screens, where it would otherwise
  // push the document a full screen down.
  const contents = document.querySelector('.contents');
  if (window.matchMedia('(max-width: 999px)').matches) contents.open = false;
</script>
`;

writeFileSync(OUT, page, 'utf8');
console.log(`wrote ${OUT} (${(page.length / 1024).toFixed(0)} KB, ${toc.length} sections)`);
