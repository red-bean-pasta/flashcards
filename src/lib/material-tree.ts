import { segmentLabel } from './source-names.js';

export interface MaterialFolder {
  name: string;
  path: string;
  folders: MaterialFolder[];
  files: MaterialFile[];
}

export interface MaterialFile {
  name: string;
  path: string;
}

export function buildMaterialTree(files: string[]): MaterialFolder {
  const root: MaterialFolder = { name: 'Root', path: '', folders: [], files: [] };

  for (const file of files) {
    const parts = file.split('/');
    let current = root;
    let currentPath = '';

    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i];
      currentPath += `${segment}/`;
      let nextFolder = current.folders.find(folder => folder.path === currentPath);
      if (!nextFolder) {
        nextFolder = {
          name: segmentLabel(segment),
          path: currentPath,
          folders: [],
          files: []
        };
        current.folders.push(nextFolder);
      }
      current = nextFolder;
    }

    const filename = parts[parts.length - 1];
    current.files.push({
      name: segmentLabel(filename),
      path: file
    });
  }

  function sortFolder(folder: MaterialFolder): void {
    folder.folders.sort((a, b) => a.name.localeCompare(b.name));
    folder.files.sort((a, b) => a.name.localeCompare(b.name));
    for (const sub of folder.folders) {
      sortFolder(sub);
    }
  }

  sortFolder(root);
  return root;
}
