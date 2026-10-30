// Re-encodes a built geometry into the shape the pages read, without changing
// what it means. This is the step that only ever existed outside the repo before
// (scripts/trim_geometry.py), and it is the reason the maps are 81MB of source
// rather than 250MB: tiles become (legend, grid) and duplicate routes collapse.
//
// Everything here is lossless and asserted so, because a silent error puts a
// spawn on the wrong path -- which looks like a working map.
import { ordered, GEOMETRY_KEY_ORDER } from './keyorder.mjs';

const sig = (obj) => JSON.stringify(obj);

/** (legend, grid) such that legend[grid[r][c]] equals tiles[r][c], per map. */
export function encodeTiles(tiles) {
  const legend = [];
  const index = new Map();
  const grid = tiles.map((row) => row.map((tile) => {
    const key = sig(tile);
    if (!index.has(key)) {
      index.set(key, legend.length);
      legend.push(tile);
    }
    return index.get(key);
  }));
  // Lossless or it does not ship. 34 tile keys DO vary between stages, which is
  // why the legend is per map rather than global.
  if (sig(grid.map((row) => row.map((i) => legend[i]))) !== sig(tiles)) {
    throw new Error('tile re-encode changed the map');
  }
  return { legend, grid };
}

/**
 * Deduplicated routes, with every reference remapped and then verified against
 * the route body it originally pointed at. Of 101,932 routes, 56,532 are exact
 * duplicates of another route in the same stage. This is the part that could
 * silently point a spawn at the wrong path, so it throws rather than shipping.
 */
export function dedupeRoutes(geo) {
  const original = geo.routes || [];
  const out = [];
  const index = new Map();
  const remap = new Map();
  original.forEach((route, i) => {
    const key = sig(route);
    if (!index.has(key)) {
      index.set(key, out.length);
      out.push(route);
    }
    remap.set(i, index.get(key));
  });

  for (const wave of geo.waves || []) {
    for (const spawn of wave.spawns || []) {
      if (Number.isInteger(spawn.route) && remap.has(spawn.route)) {
        const before = original[spawn.route];
        spawn.route = remap.get(spawn.route);
        if (sig(out[spawn.route]) !== sig(before)) throw new Error('spawn now points at a different route');
      }
    }
  }
  for (const field of ['spawn_tiles', 'objective_tiles']) {
    for (const tile of geo[field] || []) {
      const before = (tile.routes || []).filter((i) => i < original.length).map((i) => original[i]);
      tile.routes = (tile.routes || []).map((i) => (remap.has(i) ? remap.get(i) : i));
      const after = tile.routes.filter((i) => i < out.length).map((i) => out[i]);
      if (sig(after) !== sig(before)) throw new Error(`${field} now points at different routes`);
    }
  }
  return out;
}

/**
 * {geometry, conditional} in the shipped shape: camelCase, tiles indexed into a
 * per-map legend, routes deduplicated, conditional spawns split into their own
 * file so a map that has none carries no empty array. `source` is where the level
 * file was read ('en' or 'cn'); only 'cn' is written, as geometry.source.
 */
export function encodeGeometry(slug, built, source = 'en') {
  const { legend, grid } = encodeTiles(built.tiles);
  const routes = dedupeRoutes(built);
  const conditional = built.conditional_spawns || [];
  // Ordered per field, never as a whole: the top level is written in this order
  // deliberately, and handing the whole object to ordered() would sort it
  // alphabetically instead.
  const T = GEOMETRY_KEY_ORDER;
  const geometry = {
    slug,
    rows: built.rows,
    cols: built.cols,
    tileLegend: ordered(legend, T, 'tileLegend'),
    tileGrid: grid,
    routes: ordered(routes, T, 'routes'),
    waves: ordered(built.waves || [], T, 'waves'),
    spawnTiles: ordered(built.spawn_tiles || [], T, 'spawnTiles'),
    objectiveTiles: ordered(built.objective_tiles || [], T, 'objectiveTiles'),
    enemyConfigurations: ordered(built.enemy_configurations || [], T, 'enemyConfigurations'),
    suppliedUnits: ordered(built.supplied_units || { fixed_squad: [], deployable_tokens: [] }, T, 'suppliedUnits'),
    hasConditionalSpawns: Boolean(conditional.length),
  };
  // Only a map from the CN client says where it came from (lib/gamedata.mjs levelFile).
  if (source === 'cn') geometry.source = 'cn';
  return {
    geometry,
    conditional: conditional.length ? ordered(conditional, T, 'conditional_spawns') : null,
  };
}
