/**
 * Art a Node importer fetched that arkpedia-image-assets does not publish yet, staged for the
 * release's staged-art stage to publish. The rules, and why, are scripts/imports/staged_art.py's;
 * this is the same protocol for the importers written in Node:
 *
 *   const staging = beginStaging('item-icons');        // forgets the last run's list
 *   staging.stage('item-icons/act99side_token.png', bytes, { source, mirror });
 *   staging.commit();                                   // writes this run's list
 *
 * Every file lands in .cache/<kind>/, listed in .cache/<kind>/staged.json with its destination
 * in the image repository, the URL it came from and, for a game-resource mirror's file, the
 * mirror path, pinned commit and git blob the image repository maps it by.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const REGISTRY = new URL('../../config/staged-art.json', import.meta.url);
export const SIDECAR = 'staged.json';

/** The staged art kinds (config/staged-art.json). */
export const stagedKinds = () => JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).kinds;

/** The git blob id of `data`: how a mirror's tree names these exact bytes. */
export const gitBlob = data => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');

/** The image format of `data` by its signature, as the extension it is staged under. */
export function imageExtension(data) {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (data.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  return null;
}

export function beginStaging(kind, root = process.cwd()) {
  const kinds = stagedKinds();
  if (!kinds[kind]) throw new Error(`${kind} is not a staged art kind in config/staged-art.json; add it there so the staged-art stage publishes it`);
  const { folders } = kinds[kind];
  const dir = path.join(root, '.cache', kind);
  const files = {};
  fs.rmSync(path.join(dir, SIDECAR), { force: true });
  return {
    dir,
    get files() { return { ...files }; },
    /** Stages `data` for `target` (a path in the image repository); returns the staged file's path. */
    stage(target, data, { source, mirror } = {}) {
      const folder = target.split('/')[0];
      if (!folders.includes(folder) || target.split('/').includes('..') || !/^[^/]+\/[^/]+\.(?:webp|png)$/.test(target)) {
        throw new Error(`${kind} cannot stage ${target}: it publishes only into ${folders.join('/, ')}/`);
      }
      if (typeof source !== 'string' || !/^https?:\/\//.test(source)) throw new Error(`${target} needs the URL it came from, not ${JSON.stringify(source)}`);
      const extension = imageExtension(data);
      if (!extension) throw new Error(`${target}: staged art must be PNG, JPEG, WebP or GIF`);
      const file = path.join(dir, `${path.basename(target).replace(/\.[^.]+$/, '')}.${extension}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, data);
      const row = { file: path.basename(file), source, sha256: createHash('sha256').update(data).digest('hex') };
      if (mirror) {
        if (!mirror.repository || !mirror.path || !/^[0-9a-f]{40}$/.test(mirror.commit ?? '')) {
          throw new Error(`${target}: a mirror file needs its repository, path and pinned commit`);
        }
        row.mirror = { ...mirror, blob: gitBlob(data) };
      }
      files[target] = row;
      return file;
    },
    commit() {
      const targets = Object.keys(files).sort();
      if (!targets.length) return;
      fs.mkdirSync(dir, { recursive: true });
      const text = `${JSON.stringify({ version: 1, kind, files: Object.fromEntries(targets.map(target => [target, files[target]])) }, null, 2)}\n`;
      fs.writeFileSync(path.join(dir, `${SIDECAR}.tmp`), text);
      fs.renameSync(path.join(dir, `${SIDECAR}.tmp`), path.join(dir, SIDECAR));
    },
  };
}
