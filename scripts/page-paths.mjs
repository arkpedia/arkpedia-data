// Keep page names readable on disk. Escape only characters that cannot safely
// occur in a portable filename; encode the filesystem path separately for HTTP.
export function pageFilePath(route) {
  if (typeof route !== 'string' || !route.startsWith('/') || /[?#\\]/.test(route)) throw new Error('Invalid content route');
  if (route === '/') return 'pages/index.json';
  const parts = route.slice(1).split('/').map(part => {
    const decoded = decodeURIComponent(part);
    if (!decoded || decoded === '.' || decoded === '..' || /[\x00-\x1f\x7f]/.test(decoded)) throw new Error('Invalid content route segment');
    return decoded.replace(/[%/\\:*?#"<>|]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
      .replace(/[. ]$/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  });
  return `pages/${parts.join('/')}.json`;
}

export function isContentPagePath(file) {
  return typeof file === 'string' && file.startsWith('pages/') && file.endsWith('.json')
    && !/[\\?#\x00-\x1f\x7f]/.test(file)
    && file.split('/').every(part => part && part !== '.' && part !== '..');
}

export function contentFileUrlPath(file) {
  return file.split('/').map(encodeURIComponent).join('/');
}
