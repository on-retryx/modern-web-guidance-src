/**
 * Scorecard: secure-external-subresources recognises protocol-relative and http CDN URLs.
 *
 * Contract (src/analyzing/rules/secure-external-subresources.ts, via scanFiles so the
 * fastTokens pre-filter is exercised):
 * - A versioned public-CDN <script src> / <link rel=stylesheet href> without integrity is
 *   flagged whether the URL is `https://…`, protocol-relative `//…` or `http://…`
 *   (legacy jQuery-era markup commonly uses `//code.jquery.com/…`).
 * - `integrity` without `crossorigin` on a protocol-relative URL is flagged like https.
 * - Existing behaviour holds: one finding per file, exemptions (integrity+crossorigin,
 *   unversioned/floating URLs, other hosts, relative paths), zero hits on the guide demo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { defineScorecard, mean } from '../lib.ts';
import { scanFiles } from '../../src/analyzing/scanners/index.ts';
import { secureExternalSubresourcesRule } from '../../src/analyzing/rules/secure-external-subresources.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
let n = 0;

function hits(markup: string, ext = 'html'): number {
  const files = new Map([[`page${n++}.${ext}`, markup]]);
  return scanFiles(files, [secureExternalSubresourcesRule], { includeDocsAndTests: true }).length;
}
const page = (tag: string) => `<!doctype html>\n<html>\n<head>\n${tag}\n</head>\n<body></body>\n</html>\n`;
const SRI = 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC';

export default defineScorecard({
  feature: 'sri-scheme',
  title: 'SRI rule flags protocol-relative and http CDN URLs',
  cases: [
    {
      id: 'protocol-relative-script',
      description: 'flags <script src="//code.jquery.com/jquery-3.7.1.min.js">, //cdnjs, //ajax.googleapis',
      weight: 5,
      run: () =>
        mean([
          hits(page('<script src="//code.jquery.com/jquery-3.7.1.min.js"></script>')) === 1,
          hits(page('<script src="//cdnjs.cloudflare.com/ajax/libs/lodash.js/4.17.21/lodash.min.js"></script>')) === 1,
          hits(page('<script src="//ajax.googleapis.com/ajax/libs/jquery/3.7.1/jquery.min.js"></script>')) === 1,
        ]),
    },
    {
      id: 'protocol-relative-stylesheet',
      description: 'flags <link rel="stylesheet" href="//maxcdn.bootstrapcdn.com/bootstrap/3.4.1/css/bootstrap.min.css">',
      weight: 3,
      run: () =>
        hits(page('<link rel="stylesheet" href="//maxcdn.bootstrapcdn.com/bootstrap/3.4.1/css/bootstrap.min.css">')) === 1,
    },
    {
      id: 'http-script',
      description: 'flags http:// versioned CDN script',
      weight: 2,
      run: () => hits(page('<script src="http://code.jquery.com/jquery-1.12.4.min.js"></script>')) === 1,
    },
    {
      id: 'protocol-relative-jsx',
      description: 'flags a protocol-relative CDN <script> in JSX',
      weight: 2,
      run: () =>
        hits(
          'export function Lib() {\n  return <script src="//unpkg.com/react@18.3.1/umd/react.production.min.js" />;\n}\n',
          'tsx',
        ) === 1,
    },
    {
      id: 'protocol-relative-integrity-no-crossorigin',
      description: 'flags integrity without crossorigin on a protocol-relative URL',
      weight: 3,
      run: () => hits(page(`<script src="//cdn.jsdelivr.net/npm/htmx.org@1.9.12/dist/htmx.min.js" integrity="${SRI}"></script>`)) === 1,
    },
    {
      id: 'guard-protocol-relative-exemptions',
      description: 'guard: protocol-relative URLs with integrity+crossorigin, floating versions, or other hosts are not flagged',
      weight: 2,
      run: () =>
        mean([
          hits(page(`<script src="//code.jquery.com/jquery-3.7.1.min.js" integrity="${SRI}" crossorigin="anonymous"></script>`)) === 0,
          hits(page('<script src="//cdn.jsdelivr.net/npm/vue@latest/dist/vue.global.js"></script>')) === 0,
          hits(page('<script src="//cdn.example.com/lib/1.2.3/lib.min.js"></script>')) === 0,
          hits(page('<script src="/vendor/jquery-3.7.1.min.js"></script>')) === 0,
          hits(page('<script src="//code.jquery.com.evil.example/jquery-3.7.1.min.js"></script>')) === 0,
        ]),
    },
    {
      id: 'guard-https-unchanged',
      description: 'guard: https CDN script still flagged; one finding per file',
      weight: 2,
      run: () =>
        mean([
          hits(page('<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>')) === 1,
          hits(
            page(
              '<script src="//code.jquery.com/jquery-3.7.1.min.js"></script>\n<script src="https://unpkg.com/katex@0.16.9/dist/katex.min.js"></script>',
            ),
          ) === 1,
        ]),
    },
    {
      id: 'guard-demo-zero-hits',
      description: "guard: zero hits on the guide's demo.html",
      weight: 1,
      run: () => {
        const demo = fs.readFileSync(path.join(ROOT, 'guides/security/secure-external-subresources/demo.html'), 'utf8');
        return hits(demo) === 0;
      },
    },
  ],
});
