export function formatPathSpec(
  folderPath: string,
  rootName: string = ''
): string {
  const cleanFolder = folderPath.replace(/^\/+|\/+$/g, '').trim();
  const subSegments = cleanFolder ? cleanFolder.split('/').filter(Boolean) : [];

  const segments: string[] = [];
  if (rootName.trim()) {
    segments.push(rootName.trim().replace(/^\/+|\/+$/g, ''));
  }
  segments.push(...subSegments);

  if (segments.length === 0) {
    return './';
  }

  return `${segments.join('/')}/`;
}
