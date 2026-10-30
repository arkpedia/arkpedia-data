const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Runtime pages need names and a few cache keys, not copies of CDN artwork.
function buildPublicAssetIndex(root = process.cwd()) {
  const files = [], hashes = {};
  function walk(dir, relative = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(at, name);
      else if (entry.isFile() && /\.(webp|png|jpe?g|gif|svg|avif|ico)$/i.test(name)) {
        files.push(name);
        if (/^(alliance-icons|stronghold-types|stronghold-stratagems)\//.test(name)) hashes[name] = crypto.createHash('sha1').update(fs.readFileSync(at)).digest('hex').slice(0, 8);
      }
    }
  }
  walk(path.join(root, 'public'));
  // Large, immutable media lives in the public Arkpedia asset repositories.
  // Keep those paths in the index so existing callers can test availability
  // without shipping the media in the application repository or build output.
  const externalPath = path.join(root, 'data/assets/external-asset-index.json');
  if (fs.existsSync(externalPath)) {
    const external = JSON.parse(fs.readFileSync(externalPath, 'utf8'));
    files.push(...(external.files || []));
    Object.assign(hashes, external.hashes || {});
  }
  const uniqueFiles = [...new Set(files)].sort();
  const text = JSON.stringify({ files: uniqueFiles, hashes }) + '\n';
  const at = path.join(root, 'data/assets/public-asset-index.json');
  if (!fs.existsSync(at) || fs.readFileSync(at, 'utf8') !== text) fs.writeFileSync(at, text);
  return uniqueFiles.length;
}
module.exports = { buildPublicAssetIndex };
if (require.main === module) console.log(`Indexed ${buildPublicAssetIndex()} public artwork files.`);
