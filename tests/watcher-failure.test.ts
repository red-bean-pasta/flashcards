import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('an internal background reload failure terminates with its original stack and cause', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'flashcards-crash-'));
  const watcherUrl = new URL('../server/material-watcher.ts', import.meta.url).href;
  const script = `
    import { watchMaterials } from ${JSON.stringify(watcherUrl)};
    import { writeFile } from 'node:fs/promises';
    const failure = new Error('INTERNAL_RELOAD_BUG', { cause: new Error('ORIGINAL_RENDER_CAUSE') });
    await watchMaterials(process.argv[1], async () => { throw failure; }, () => {
      throw new Error('Internal error was incorrectly classified as filesystem input');
    });
    await writeFile(process.argv[1] + '/deck.md', '# question\\nQ\\n# answer\\nA');
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, directory], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Background failure did not terminate the process')); }, 8000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); resolve(code); });
    });
    assert.notEqual(code, 0);
    assert.match(stderr, /INTERNAL_RELOAD_BUG/);
    assert.match(stderr, /ORIGINAL_RENDER_CAUSE/);
    assert.match(stderr, /at /);
    assert.doesNotMatch(stderr, /incorrectly classified/);
  } finally { child.kill(); await rm(directory, { recursive: true, force: true }); }
});
