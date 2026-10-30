import type { AccessibleDirectory } from './local-folder';
import { recallLocalFolder } from './storage-memory';

export async function inspectSavedFolder(): Promise<{ folder: AccessibleDirectory; permission: PermissionState } | undefined> {
  const folder = await recallLocalFolder() as AccessibleDirectory | undefined;
  if (!folder) return undefined;
  const permission = await folder.queryPermission({ mode: 'readwrite' });
  return { folder, permission };
}
