// Every dict's keys in a published order, recursively.
//
// The point is byte-stable output: two runs of the same input must produce the
// same file, and a field must not move because an upstream table changed its
// iteration order. A dict is ordered by the KEY IT HANGS UNDER, which is how the
// dicts inside `spawns` all get the spawn order. Keys the table does not mention
// are appended alphabetically, so nothing is ever dropped.
const POSITION = ['row', 'col'];

export const GEOMETRY_KEY_ORDER = {
  options: ['max_life', 'squad_size', 'initial_dp', 'max_dp', 'dp_per_second',
    'dp_recovery_interval_seconds', 'max_play_time_seconds'],
  supplied_units: ['fixed_squad', 'deployable_tokens'],
  suppliedUnits: ['fixed_squad', 'deployable_tokens'],
  fixed_squad: ['unit', 'unit_id', 'level', 'elite', 'potential', 'skill_index', 'skill_level', 'hidden'],
  deployable_tokens: ['unit', 'unit_id', 'count', 'level', 'elite', 'potential',
    'skill_index', 'skill_level', 'hidden'],
  enemy_configurations: ['enemy_id', 'slug', 'name', 'database_level', 'overrides', 'source'],
  enemyConfigurations: ['enemy_id', 'slug', 'name', 'database_level', 'overrides', 'source'],
  grid: ['rows', 'cols'],
  tiles: ['key', 'height', 'walkable', 'deployable', 'flyable', 'blackboard'],
  tileLegend: ['key', 'height', 'walkable', 'deployable', 'flyable', 'blackboard'],
  spawn_tiles: ['key', 'row', 'col', 'routes'],
  objective_tiles: ['key', 'row', 'col', 'routes'],
  spawnTiles: ['key', 'row', 'col', 'routes'],
  objectiveTiles: ['key', 'row', 'col', 'routes'],
  routes: ['motion', 'placeholder', 'start', 'end', 'checkpoints', 'waits'],
  extra_routes: ['motion', 'placeholder', 'start', 'end', 'checkpoints', 'waits'],
  start: POSITION,
  end: POSITION,
  position: POSITION,
  checkpoints: ['type', 'position'],
  waits: ['type', 'after_checkpoint', 'seconds'],
  waves: ['index', 'duration', 'pre_delay', 'post_delay', 'max_wait_for_next_wave', 'spawns'],
  spawns: ['enemy', 'enemy_id', 'count', 'time', 'interval', 'route', 'fragment'],
  conditional_spawns: ['enemy', 'enemy_id', 'count', 'time', 'interval', 'route',
    'wave', 'fragment', 'phase', 'branch', 'source', 'condition'],
  condition: ['hidden_group', 'random_group', 'random_group_pack', 'weight'],
};

function ranks(table) {
  const out = new Map();
  for (const [where, order] of Object.entries(table)) {
    const rank = new Map();
    order.forEach((key, position) => {
      if (rank.has(key)) throw new Error(`${key} listed twice in a key order`);
      rank.set(key, position);
    });
    out.set(where, rank);
  }
  return out;
}

/** `value` with every object's keys ordered by `table`, recursively. A copy. */
export function ordered(value, table, key = null) {
  const R = table.__ranks || (table.__ranks = ranks(table));
  const walk = (node, under) => {
    if (Array.isArray(node)) return node.map((item) => walk(item, under));
    if (node == null || typeof node !== 'object') return node;
    const rank = R.get(under) || new Map();
    const last = rank.size;    // everything unlisted, then by name
    const keys = Object.keys(node).sort((a, b) => (
      (rank.get(a) ?? last) - (rank.get(b) ?? last) || (a < b ? -1 : a > b ? 1 : 0)));
    const out = {};
    // A list does not rename its items: the objects inside `spawns` are still
    // under `spawns`, which is how a list of records gets the record order.
    for (const k of keys) out[k] = walk(node[k], k);
    return out;
  };
  return walk(value, key);
}
