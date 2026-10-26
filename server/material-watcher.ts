import path from 'node:path';
import { watch } from 'chokidar';
import { isFilesystemError } from './filesystem.js';

function affectsMaterials(event: string, filename: string): boolean {
  return path.extname(filename).toLowerCase() === '.md' || event === 'addDir' || event === 'unlinkDir';
}

function crashOnInternalFailure(error: unknown): never {
  // Throw the original value at the event-loop boundary, retaining its stack/cause.
  throw error;
}

export async function watchMaterials(
  directory: string,
  reload: () => Promise<void>,
  reportFilesystemError: (error: NodeJS.ErrnoException) => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();
  const watcher = watch(directory, {
    ignoreInitial: true, followSymlinks: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  function enqueueReload(): void {
    pending = pending.then(reload);
    void pending.catch(error => {
      queueMicrotask(() => crashOnInternalFailure(error));
    });
  }

  function scheduleReload(event: string, filename: string): void {
    if (!affectsMaterials(event, filename)) return;
    clearTimeout(timer);
    timer = setTimeout(enqueueReload, 100);
  }

  function reportWatcherError(error: unknown): void {
    if (!isFilesystemError(error)) throw error;
    reportFilesystemError(error);
  }

  async function waitUntilReady(): Promise<void> {
    let rejectStartup: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      rejectStartup = reject;
      watcher.once('ready', resolve);
      watcher.once('error', rejectStartup);
    });
    try {
      await ready;
    } catch (error) {
      await watcher.close();
      throw error;
    } finally {
      watcher.off('error', rejectStartup!);
    }
  }

  async function close(): Promise<void> {
    clearTimeout(timer);
    await watcher.close();
    await pending;
  }

  watcher.on('all', scheduleReload);
  await waitUntilReady();
  watcher.on('error', reportWatcherError);
  return { close };
}
