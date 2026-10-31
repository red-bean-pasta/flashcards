import { createLoadBudget } from '../load-budget.js';
import { archiveFilename, isNewSourceName, appendArchivedEntries } from '../card-text.js';
import { CardParseError } from '../card-ranges.js';
import { CardInputError } from '../card-text.js';
import { parseBrowserCards } from '../browser-cards.js';
import { DeckRequestError } from '../deck-client.js';
import type { DeckState, MutationRequest } from '../types.js';
import { GraphError, type GraphClient, type GraphItem } from './graph.js';
import { OneDriveAuthError } from './auth.js';
import { captureOperation, planContent, createOperationProjector, isUnchangedEdit, validateTargets, type CardOperation } from './operations.js';
import type { StoredMutation, MutationWritePlan } from '../mutation-storage.js';
import { validateMutationPlan } from '../mutation-plan.js';
import { createSnapshotCache, type SnapshotCache, type FileSnapshot } from './snapshot-cache.js';

export function asDeckError(error: unknown): never {
  if (error instanceof GraphError || error instanceof OneDriveAuthError || error instanceof CardParseError || error instanceof CardInputError) {
    throw new DeckRequestError(error.message, { cause: error });
  }
  throw error;
}

export function createOneDriveStore(graph: GraphClient, folder: GraphItem, parse = parseBrowserCards, cache: SnapshotCache = createSnapshotCache()) {
  if (!folder.folder) throw new Error('A OneDrive deck requires a folder item.');
  const projectOperation = createOperationProjector(parse);
  const sources = new Map<string, GraphItem>();
  let saving = false;
  let cacheReady = false;

  async function scan(id: string, found: Map<string, GraphItem>, signal?: AbortSignal, prefix = '', ancestors = new Set<string>(), budget = createLoadBudget()): Promise<void> {
    signal?.throwIfAborted();
    if (ancestors.has(id)) throw new DeckRequestError('OneDrive returned a recursive folder.');
    const nextAncestors = new Set([...ancestors, id]);
    for (const item of await graph.children(id, signal, budget.remainingEntries())) {
      signal?.throwIfAborted();
      if (item.name.startsWith('.') || item.name.toLowerCase() === archiveFilename) continue;
      const source = prefix + item.name;
      budget.entry(source);
      if (item.folder) await scan(item.id, found, signal, source + '/', nextAncestors, budget);
      else if (item.file && /\.md$/i.test(item.name)) found.set(source, item);
    }
  }

  async function load(signal?: AbortSignal): Promise<DeckState> {
    cacheReady = false;
    try {
      const found = new Map<string, GraphItem>();
      const budget = createLoadBudget();
      await scan(folder.id, found, signal, '', new Set(), budget);
      const cards: DeckState['cards'] = [];
      const errors: string[] = [];
      const revisions: Record<string, string> = {};
      for (const [source, item] of found) {
        signal?.throwIfAborted();
        try {
          const snapshot = await graph.readText(item.id, signal, budget.remainingBytes());
          budget.file(source, new TextEncoder().encode(snapshot.text).byteLength);
          await cache.put(source, snapshot);
          cards.push(...parse(snapshot.text, source));
          revisions[source] = snapshot.revision;
        } catch (error) {
          if (!(error instanceof CardParseError)) throw error;
          errors.push(error.message);
        }
      }
      const archive = await graph.findChild(folder.id, archiveFilename);
      if (archive && !archive.file) throw new DeckRequestError('removed.md is not a file.');
      await cache.put(archiveFilename, archive ? await graph.readText(archive.id, signal) : null);
      signal?.throwIfAborted();
      sources.clear();
      for (const [source, item] of found) sources.set(source, item);
      cacheReady = true;
      return { cards: errors.length ? [] : cards, files: [...sources.keys()].sort(), revisions, errors };
    } catch (error) { asDeckError(error); }
  }

  async function validateSourcePath(path: string, expectedId: string): Promise<void> {
    let parent = folder.id;
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index++) {
      const item = await graph.findChild(parent, parts[index]);
      if (!item || item.name !== parts[index] || (index < parts.length - 1 ? !item.folder : !item.file || item.id !== expectedId)) {
        throw new DeckRequestError(`The file ${path} was moved, renamed, or replaced. Refresh before saving.`);
      }
      parent = item.id;
    }
  }

  async function refreshSnapshot(name: string): Promise<FileSnapshot | null> {
    let item = sources.get(name);
    if (name === archiveFilename || !item) item = await graph.findChild(folder.id, name) ?? undefined;
    if (item && !item.file) throw new DeckRequestError(`${name} is not a file.`);
    if (item && name !== archiveFilename) await validateSourcePath(name, item.id);
    const snapshot = item ? await graph.readText(item.id) : null;
    await cache.put(name, snapshot);
    if (item && name !== archiveFilename) sources.set(name, item);
    return snapshot;
  }

  async function sourcePlan(operation: CardOperation, snapshot: DeckState, refresh = false): Promise<{ plan: MutationWritePlan; removed: string }> {
    let before = refresh ? await refreshSnapshot(operation.source) : await cache.get(operation.source);
    if (before === undefined) {
      if (!sources.has(operation.source) && isNewSourceName(operation.source) && operation.action === 'add') before = null;
      else before = await refreshSnapshot(operation.source);
    }
    if (!before && operation.action !== 'add') throw new DeckRequestError('This card file is no longer available. Refresh to review your notes.');
    validateTargets(before?.text ?? '', operation, snapshot);
    const change = planContent(before?.text ?? '', operation);
    return { plan: { id: before?.id ?? null, name: operation.source, before: before?.text ?? null, revision: before?.revision ?? null, after: change.text }, removed: change.removed };
  }

  async function archivePlan(removed: string, refresh = false): Promise<MutationWritePlan> {
    const cached = refresh ? await refreshSnapshot(archiveFilename) : await cache.get(archiveFilename);
    const before = cached === undefined ? await refreshSnapshot(archiveFilename) : cached;
    if (before) parse(before.text, archiveFilename);
    const after = appendArchivedEntries(before?.text ?? '', removed);
    parse(after, archiveFilename);
    return { id: before?.id ?? null, name: archiveFilename, before: before?.text ?? null, revision: before?.revision ?? null, after };
  }

  async function publish(plan: MutationWritePlan): Promise<GraphItem> {
    if (plan.id !== null) {
      if (plan.revision === null) throw new Error('Existing-file write plan requires an eTag.');
      return graph.replaceText(plan.id, plan.revision, plan.after);
    }
    return graph.createFile(folder.id, plan.name, plan.after);
  }

  async function refreshRejected(name: string, error: GraphError): Promise<void> {
    try { await refreshSnapshot(name); }
    catch (failure) { throw new AggregateError([error, failure], `OneDrive rejected the save and ${name} could not be refreshed.`); }
  }

  async function mutate(request: MutationRequest, deck: DeckState): Promise<DeckState> {
    try {
      const operation = captureOperation(deck, request);
      const item: StoredMutation = { id: crypto.randomUUID(), createdAt: Date.now(), destination: { provider: 'onedrive', driveId: await graph.driveId(), folderId: folder.id }, request, operation, snapshot: deck, stage: 'queued', attempts: 0 };
      return await execute(item, async () => {});
    } catch (error) { asDeckError(error); }
  }

  async function execute(item: StoredMutation, checkpoint: (item: StoredMutation) => Promise<void>, _recovered = false): Promise<DeckState> {
    if (saving) throw new Error('Concurrent mutation submitted to one browser store.');
    saving = true;
    async function advance(patch: Partial<StoredMutation>) { Object.assign(item, patch); await checkpoint(item); }

    async function preparePlans() {
      if (!item.sourceWrite) {
        await advance({ stage: 'preparing' });
        const source = await sourcePlan(item.operation, item.snapshot);
        const archive = item.operation.action === 'remove' ? await archivePlan(source.removed) : undefined;
        await advance({ sourceWrite: source.plan, archiveWrite: archive, stage: archive ? 'archive-ready' : 'source-ready' });
      }
      validateMutationPlan(item);
    }

    async function recoverAndPublishArchive() {
      if (item.stage === 'archive-writing') throw new DeckRequestError('The previous OneDrive archive write may still be in flight. Review the files manually before dismissing this change.');
      if (item.stage === 'archive-ready') {
        if (!item.archiveWrite) throw new Error('Archive stage requires its plan.');
        let confirmedNoop = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          const plan = item.archiveWrite!;
          if (plan.after === (plan.before ?? '')) {
            if (!confirmedNoop) {
              const removed = planContent(item.sourceWrite!.before ?? '', item.operation).removed;
              await advance({ archiveWrite: await archivePlan(removed, true) });
              confirmedNoop = true;
              if (item.archiveWrite!.after !== (item.archiveWrite!.before ?? '')) { attempt--; continue; }
            }
            await advance({ stage: 'source-ready' }); return;
          }
          await advance({ stage: 'archive-writing' });
          if (plan.id) await validateSourcePath(plan.name, plan.id);
          try {
            const saved = await publish(plan);
            await cache.put(plan.name, { id: saved.id, text: plan.after, revision: saved.eTag! });
          }
          catch (error) {
            if (!(error instanceof GraphError) || error.uncertain) throw error;
            await advance({ stage: 'archive-ready' });
            await refreshRejected(plan.name, error);
            if (![409, 412].includes(error.status)) throw error;
            const removed = planContent(item.sourceWrite!.before ?? '', item.operation).removed;
            await advance({ archiveWrite: await archivePlan(removed), stage: 'archive-ready' });
            if (attempt === 2) throw new GraphError('OneDrive changed repeatedly. The save will retry with the latest file.', { status: error.status, code: 'retryableConflict' }, false, { cause: error });
            continue;
          }
          await advance({ stage: 'source-ready' });
          return;
        }
      }
    }

    async function recoverAndPublishSource() {
      if (item.stage === 'source-writing') throw new DeckRequestError('The previous OneDrive source write may still be in flight. Review the files manually before dismissing this change.');
      if (item.stage === 'source-ready') {
        let confirmedNoop = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          const plan = item.sourceWrite!;
          if (plan.before === plan.after) {
            if (!confirmedNoop) {
              const replacement = await sourcePlan(item.operation, item.snapshot, true);
              const archive = item.operation.action === 'remove' ? await archivePlan(replacement.removed) : undefined;
              await advance({ sourceWrite: replacement.plan, archiveWrite: archive, stage: archive ? 'archive-ready' : 'source-ready' });
              if (archive) await recoverAndPublishArchive();
              confirmedNoop = true;
              if (replacement.plan.before !== replacement.plan.after) { attempt--; continue; }
            }
            await advance({ stage: 'releasing' }); break;
          }
          await advance({ stage: 'source-writing' });
          if (plan.id) await validateSourcePath(plan.name, plan.id);
          try {
            const saved = await publish(plan);
            await cache.put(plan.name, { id: saved.id, text: plan.after, revision: saved.eTag! });
          }
          catch (error) {
            if (!(error instanceof GraphError) || error.uncertain) throw error;
            await advance({ stage: 'source-ready' });
            await refreshRejected(plan.name, error);
            if (![409, 412].includes(error.status)) throw error;
            const replacement = await sourcePlan(item.operation, item.snapshot);
            const archive = item.operation.action === 'remove' ? await archivePlan(replacement.removed, true) : undefined;
            await advance({ sourceWrite: replacement.plan, archiveWrite: archive, stage: archive ? 'archive-ready' : 'source-ready' });
            if (attempt === 2) throw new GraphError('OneDrive changed repeatedly. The save will retry with the latest file.', { status: error.status, code: 'retryableConflict' }, false, { cause: error });
            if (archive) await recoverAndPublishArchive();
            continue;
          }
          await advance({ stage: 'releasing' });
          break;
        }
      }
    }

    async function finish(): Promise<DeckState> {
      if (item.stage !== 'releasing') throw new Error('Unexpected pending mutation stage.');
      const current = await cache.get(item.sourceWrite!.name);
      if (!current) throw new DeckRequestError('The saved file is no longer available. Review the pending change.');
      sources.set(item.sourceWrite!.name, { id: current.id, name: item.sourceWrite!.name.split('/').at(-1)!, file: {}, eTag: current.revision });
      const applied = item.operation.action === 'add' || planContent(item.sourceWrite!.before ?? '', item.operation).matched > 0;
      return projectOperation(item.snapshot, item.operation, current.revision, current.text, applied);
    }

    try {
      if (isUnchangedEdit(item.operation)) return item.snapshot;
      if (!cacheReady) throw new DeckRequestError('Refresh the OneDrive folder before saving.');
      await preparePlans();
      await recoverAndPublishArchive();
      await recoverAndPublishSource();
      return await finish();
    } catch (error) { asDeckError(error); }
    finally { saving = false; }
  }

  return { load, mutate, execute, dispose: () => cache.clear() };
}

export type OneDriveStore = ReturnType<typeof createOneDriveStore>;
