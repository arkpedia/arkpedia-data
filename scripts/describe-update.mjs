// Describe the actual diff; do not call an asset-only refresh a game update.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [base, titleFile, bodyFile] = process.argv.slice(2);
if (!base || !titleFile || !bodyFile) throw new Error('Expected base, title file and body file');
const files = execFileSync('git', ['diff', '--name-only', '-z', `${base}...HEAD`], { encoding: 'utf8' }).split('\0').filter(Boolean);
const sources = files.filter(file => file.startsWith('source/'));
const pages = files.filter(file => file.startsWith('release/pages/'));
const generated = files.filter(file => file.startsWith('release/'));
const assetOnly = sources.length === 1 && sources[0] === 'source/data/assets/revisions.json';
const title = assetOnly ? 'Refresh asset references' : 'Update game content';
const intro = assetOnly
  ? 'Updates the pinned asset repository versions. Game records are unchanged.'
  : 'Updates the public game records and their generated page data together.';
const body = `${intro}\n\n${sources.length} source file(s), ${pages.length} generated page payload(s), ${generated.length} generated file(s) in total.\n\nReview these source changes:\n${sources.slice(0, 30).map(file => `- \`${file}\``).join('\n')}${sources.length > 30 ? '\n- Additional source files are listed in the diff.' : ''}\n\nAsset versions live in the release manifest; voice URLs are resolved at playback. Presentation clocks are supplied when serving a page. An asset-only refresh should not rewrite operator pages.\n\nValidation checks source and output checksums before publication. Merging publishes this content version without rebuilding the Arkpedia website. This workflow never approves or merges the PR.\n`;
writeFileSync(titleFile, title + '\n');
writeFileSync(bodyFile, body);
