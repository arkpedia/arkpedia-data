/** Stable game IDs join the furniture checklist to the client's shop thumbnails.
 * Keep both regions: Global takes precedence once its art is published. The source
 * fallback supports existing content releases until their rewards are regenerated. */
export function furnitureThemeId(group) {
  const id = group.themeId ?? group.source?.match(/^(?:CN )?building_data (furni_set_[a-zA-Z0-9_]+)$/)?.[1];
  return /^furni_set_[a-zA-Z0-9_]+$/.test(id ?? '') ? id : null;
}

export function furnitureArtPath(group, isPublished) {
  const id = furnitureThemeId(group);
  if (!id) return null;
  for (const region of ['en', 'cn']) {
    const file = `content-art/${id}-${region}.webp`;
    if (isPublished(file)) return `/${file}`;
  }
  return null;
}
