import { loadOneDriveDeck } from './deck-load.js';
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

/** Only aggregates made entirely of expected external failures are recoverable. */
function externalFailureMessages(error: unknown): string[] | undefined {
  if (error instanceof GraphError || error instanceof OneDriveAuthError || error instanceof CardParseError || error instanceof CardInputError || error instanceof DeckRequestError) return [error.message];
  if (!(error instanceof AggregateError) || !error.errors.length) return undefined;
  const messages: string[] = [];
  for (const failure of error.errors) {
    const nested = externalFailureMessages(failure);
    if (!nested) return undefined;
    messages.push(...nested);
  }
  return messages;
}

export function asDeckError(error: unknown): never {
  if (error instanceof DeckRequestError) throw error;
  const messages = externalFailureMessages(error);
  if (messages) throw new DeckRequestError([...new Set(messages)].join('; '), { cause: error });
  throw error;
}

function retryableConflict(cause: GraphError) {
  return new GraphError('OneDrive changed repeatedly. The save will retry with the latest file.', { status: cause.status, code: 'retryableConflict' }, false, { cause });
}

export function createOneDriveStore(graph: GraphClient, folder: GraphItem, parse = parseBrowserCards, cache: SnapshotCache = createSnapshotCache()) {
  if (!folder.folder) throw new Error('A OneDrive deck requires a folder item.');
  const projectOperation = createOperationProjector(parse);
  let sources = new Map<string, GraphItem>();
  let saving = false;
  let cacheReady = false;

  async function load(signal?: AbortSignal): Promise<DeckState> {
    cacheReady = false;
    try {
      const loaded = await loadOneDriveDeck(graph, folder, cache, parse, signal);
      signal?.throwIfAborted();
      sources = loaded.sources;
      cacheReady = true;
      return loaded.deck;
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

  // Intentional optimistic first-write policy: plan from cached text/eTag instead
  // of rereading content in the usual no-race case. publish uses If-Match (or
  // no-clobber creation); a definite 409/412 causes refresh and replanning.
  // Path-membership checks still apply; uncertain writes must not be blindly replayed.
  async function sourcePlan(operation: CardOperation, refresh = false): Promise<{ plan: MutationWritePlan; removed: string }> {
    let before = refresh ? await refreshSnapshot(operation.source) : await cache.get(operation.source);
    if (before === undefined) {
      if (!sources.has(operation.source) && isNewSourceName(operation.source) && operation.action === 'add') before = null;
      else before = await refreshSnapshot(operation.source);
    }
    if (!before && operation.action !== 'add') throw new DeckRequestError('This card file is no longer available. Refresh to review your notes.');
    validateTargets(operation);
    const change = planContent(before?.text ?? '', operation);
    return { plan: { id: before?.id ?? null, name: operation.source, before: before?.text ?? null, revision: before?.revision ?? null, after: change.text }, removed: change.removed };
  }

  // Archive writes use the same cached-first, conditional-write policy as sources.
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

    async function publishPlannedWrite(plan: MutationWritePlan, target: 'archive' | 'source') {
      if (plan.id) await validateSourcePath(plan.name, plan.id);
      await advance({ stage: `${target}-writing` });
      try {
        const saved = await publish(plan);
        await cache.put(plan.name, { id: saved.id, text: plan.after, revision: saved.eTag! });
      } catch (error) {
        if (error instanceof OneDriveAuthError) {
          await advance({ stage: `${target}-ready` });
          throw error;
        }
        if (!(error instanceof GraphError) || error.uncertain) throw error;
        await advance({ stage: `${target}-ready` });
        await refreshRejected(plan.name, error);
        if (![409, 412].includes(error.status)) throw error;
        return error;
      }
    }

    async function preparePlans() {
      if (!item.sourceWrite) {
        await advance({ stage: 'preparing' });
        const source = await sourcePlan(item.operation);
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
          const conflict = await publishPlannedWrite(plan, 'archive');
          if (conflict) {
            const removed = planContent(item.sourceWrite!.before ?? '', item.operation).removed;
            await advance({ archiveWrite: await archivePlan(removed), stage: 'archive-ready' });
            if (attempt === 2) throw retryableConflict(conflict);
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
              const replacement = await sourcePlan(item.operation, true);
              const archive = item.operation.action === 'remove' ? await archivePlan(replacement.removed) : undefined;
              await advance({ sourceWrite: replacement.plan, archiveWrite: archive, stage: archive ? 'archive-ready' : 'source-ready' });
              if (archive) await recoverAndPublishArchive();
              confirmedNoop = true;
              if (replacement.plan.before !== replacement.plan.after) { attempt--; continue; }
            }
            await advance({ stage: 'releasing' }); break;
          }
          const conflict = await publishPlannedWrite(plan, 'source');
          if (conflict) {
            const replacement = await sourcePlan(item.operation);
            const archive = item.operation.action === 'remove' ? await archivePlan(replacement.removed, true) : undefined;
            await advance({ sourceWrite: replacement.plan, archiveWrite: archive, stage: archive ? 'archive-ready' : 'source-ready' });
            if (attempt === 2) throw retryableConflict(conflict);
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
