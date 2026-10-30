// Exact Global source coverage, rather than a minimum total that lets a new event
// disappear unnoticed. Exclusions affect navigation only; their records survive.
export const INDEX_EXCLUDED_TYPES = new Set(['special_story']);
export function assertStageCoverage({ stages, records, index, excluded = {}, geometryExists }) {
  const errors = [];
  const ids = new Map();
  const slugs = new Set();
  for (const record of records) {
    if (!record.id || !record.slug || ids.has(record.id) || slugs.has(record.slug)) {
      errors.push(`duplicate or empty stage identity: ${record.id} / ${record.slug}`);
    }
    ids.set(record.id, record);
    slugs.add(record.slug);
    if (!record.content?.id) errors.push(`${record.id}: no content`);
    if (record.geometry && geometryExists && !geometryExists(record.geometry)) errors.push(`${record.id}: missing geometry ${record.geometry}`);
  }
  for (const id of Object.keys(stages)) if (!ids.has(id)) errors.push(`Global stage_table row missing: ${id}`);
  if (index) {
    const listed = new Set();
    for (const row of index) {
      if (listed.has(row.slug)) errors.push(`duplicate index slug: ${row.slug}`);
      listed.add(row.slug);
      if (!slugs.has(row.slug)) errors.push(`index has no record: ${row.slug}`);
    }
    for (const record of records) {
      const hidden = Object.hasOwn(excluded, record.content?.id ?? '') || INDEX_EXCLUDED_TYPES.has(record.stage_type);
      if (listed.has(record.slug) === hidden) errors.push(`${record.id}: ${hidden ? 'excluded stage listed' : 'stage missing from index'}`);
    }
  }
  if (errors.length) throw new Error(`Stage coverage failed (${errors.length}):\n${errors.slice(0, 30).join('\n')}`);
  return { tableRows: Object.keys(stages).length, records: records.length, indexed: index?.length ?? null };
}
