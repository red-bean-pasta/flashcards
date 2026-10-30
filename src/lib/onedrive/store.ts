import { createLoadBudget } from '../load-budget.js';
import { archiveFilename, isNewSourceName, appendArchivedEntries } from '../card-text.js';
import { CardParseError } from '../card-ranges.js';
import { CardInputError } from '../card-text.js';
import { parseBrowserCards } from '../browser-cards.js';
import { DeckRequestError } from '../deck-client.js';
import type { DeckState, MutationRequest } from '../types.js';
import { GraphError, type GraphClient, type GraphItem } from './graph.js';
import { OneDriveAuthError } from './auth.js';
import { createOperationJournal, type PendingOperation, type WritePlan } from './journal.js';
import { captureOperation, planContent, createOperationProjector, isUnchangedEdit, type CardOperation } from './operations.js';
import type { StoredMutation, MutationWritePlan } from '../mutation-storage.js';
import { reviewArchive, reviewSource } from '../mutation-review.js';
import { validateMutationPlan } from '../mutation-plan.js';

export function asDeckError(error: unknown): never {
  if (error instanceof GraphError || error instanceof OneDriveAuthError || error instanceof CardParseError || error instanceof CardInputError) {
    throw new DeckRequestError(error.message, { cause: error });
  }
  throw error;
}

export function createOneDriveStore(graph: GraphClient, folder: GraphItem, parse = parseBrowserCards) {
  if (!folder.folder) throw new Error('A OneDrive deck requires a folder item.');
  const projectOperation = createOperationProjector(parse);
  const sources = new Map<string, GraphItem>();
  const journal = createOperationJournal(graph, folder.id);
  let saving = false;

  async function scan(id: string, found: Map<string, GraphItem>, signal?: AbortSignal, prefix = '', ancestors = new Set<string>(), budget = createLoadBudget()): Promise<void> {
    signal?.throwIfAborted();
    if (ancestors.has(id)) throw new DeckRequestError('OneDrive returned a recursive folder.');
    const nextAncestors = new Set([...ancestors, id]);
    for (const item of await graph.children(id, signal)) {
      signal?.throwIfAborted();
      if (item.name.startsWith('.') || item.name.toLowerCase() === archiveFilename) continue;
      const source = prefix + item.name;
      budget.entry(source);
      if (item.folder) await scan(item.id, found, signal, source + '/', nextAncestors, budget);
      else if (item.file && /\.md$/i.test(item.name)) found.set(source, item);
    }
  }

  async function load(signal?: AbortSignal): Promise<DeckState> {
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
          const snapshot = await graph.readText(item.id, signal);
          budget.file(source, new TextEncoder().encode(snapshot.text).byteLength);
          cards.push(...parse(snapshot.text, source));
          revisions[source] = snapshot.revision;
        } catch (error) {
          if (!(error instanceof CardParseError)) throw error;
          errors.push(error.message);
        }
      }
      signal?.throwIfAborted();
      sources.clear();
      for (const [source, item] of found) sources.set(source, item);
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

  async function sourcePlan(operation: CardOperation): Promise<{ plan: WritePlan; removed: string }> {
    let item = sources.get(operation.source);
    if (!item) {
      if (operation.action !== 'add') throw new DeckRequestError('This card file is no longer available. Refresh to review your notes.');
      if (!isNewSourceName(operation.source)) throw new DeckRequestError('New filenames must use file_name.md without a folder path.');
      item = await graph.findChild(folder.id, operation.source) ?? undefined;
      if (item && !item.file) throw new DeckRequestError('That name belongs to a folder. Choose another filename.');
      if (item) sources.set(operation.source, item);
    }
    if (item) await validateSourcePath(operation.source, item.id);
    const before = item ? await graph.readText(item.id) : null;
    const change = planContent(before?.text ?? '', operation);
    return { plan: { id: item?.id ?? null, name: operation.source, before: before?.text ?? null, revision: before?.revision ?? null, after: change.text }, removed: change.removed };
  }

  async function archivePlan(removed: string): Promise<WritePlan> {
    const item = await graph.findChild(folder.id, archiveFilename);
    if (item && !item.file) throw new DeckRequestError('removed.md is not a file. The source was not removed.');
    const before = item ? await graph.readText(item.id) : null;
    if (before) parse(before.text, archiveFilename);
    const after = appendArchivedEntries(before?.text ?? '', removed);
    parse(after, archiveFilename);
    return { id: item?.id ?? null, name: archiveFilename, before: before?.text ?? null, revision: before?.revision ?? null, after };
  }

  async function publish(plan: WritePlan): Promise<GraphItem> {
    if (plan.id !== null) {
      if (plan.revision === null) throw new Error('Existing-file write plan requires an eTag.');
      return graph.replaceText(plan.id, plan.revision, plan.after);
    }
    return graph.createFile(folder.id, plan.name, plan.after);
  }

  async function mutate(request: MutationRequest, deck: DeckState): Promise<DeckState> {
    try {
      const operation = captureOperation(deck, request);
      const item: StoredMutation = { id: crypto.randomUUID(), createdAt: Date.now(), destination: { provider: 'onedrive', driveId: await graph.driveId(), folderId: folder.id }, request, operation, snapshot: deck, stage: 'queued', attempts: 0 };
      return await execute(item, async () => {});
    } catch (error) { asDeckError(error); }
  }

  async function pending(): Promise<PendingOperation | null> {
    try { return await journal.inspect(); } catch (error) { asDeckError(error); }
  }

  /** Retry only the same prepared conditional replacement, never a re-appended add. */
  async function recover(): Promise<void> {
    if (saving) throw new Error('Cannot recover during an active mutation.');
    saving = true;
    try {
      let operation = await journal.inspect();
      if (!operation) return;
      if (operation.stage.startsWith('archive')) {
        if (!operation.archiveWrite) throw new Error('Archive stage lacks an archive plan.');
        await journal.update({ ...operation, stage: 'archive-writing' });
        await publish(operation.archiveWrite);
        operation = { ...operation, stage: 'source-ready' };
        await journal.update(operation);
      }
      await journal.update({ ...operation, stage: 'source-writing' });
      await publish(operation.sourceWrite);
      await journal.release(operation.id);
    } catch (error) {
      if (error instanceof GraphError && [409, 412].includes(error.status)) throw new DeckRequestError('The saved revision changed. The pending save cannot be repeated safely. Check the current file and recovery details before clearing it.', { cause: error });
      asDeckError(error);
    } finally { saving = false; }
  }

  async function clearReviewed(id: string): Promise<void> {
    if (saving) throw new Error('Cannot clear recovery during an active mutation.');
    try { await journal.release(id); } catch (error) { asDeckError(error); }
  }

  async function currentPlan(plan: MutationWritePlan): Promise<{ text: string; revision: string; item: GraphItem } | null> {
    let item: GraphItem | null;
    if (plan.id) {
      await validateSourcePath(plan.name, plan.id);
      item = await graph.getItem(plan.id);
    } else item = await graph.findChild(folder.id, plan.name);
    if (!item) return null;
    if (!item.file) throw new DeckRequestError('The pending save target is not a file. Review it before continuing.');
    const snapshot = await graph.readText(item.id);
    return { item, text: snapshot.text, revision: snapshot.revision };
  }

  function samePlan(a: MutationWritePlan | undefined, b: MutationWritePlan | undefined): boolean {
    if (!a || !b) return a === b;
    return a.id === b.id && a.name === b.name && a.before === b.before && a.after === b.after && a.revision === b.revision;
  }

  async function execute(item: StoredMutation, checkpoint: (item: StoredMutation) => Promise<void>): Promise<DeckState> {
    if (saving) throw new Error('Concurrent mutation submitted to one browser store.');
    saving = true;
    async function advance(patch: Partial<StoredMutation>) { Object.assign(item, patch); await checkpoint(item); }
    let pending: PendingOperation | null = null;

    async function preparePlans() {
      if (!item.sourceWrite) {
        await advance({ stage: 'preparing' });
        const source = await sourcePlan(item.operation);
        const archive = item.operation.action === 'remove' ? await archivePlan(source.removed) : undefined;
        await advance({ sourceWrite: source.plan, archiveWrite: archive, stage: archive ? 'archive-ready' : 'source-ready' });
      }
      validateMutationPlan(item);
    }

    async function reconcileJournal() {
      const source = item.sourceWrite!;
      pending = await journal.inspect();
      if (pending && pending.id !== item.id) throw new DeckRequestError('Another pending OneDrive save needs review before this change can continue.');
      if (pending && (pending.action !== item.operation.action || pending.source !== item.operation.source ||
          !samePlan(pending.sourceWrite, source) || !samePlan(pending.archiveWrite, item.archiveWrite))) {
        throw new DeckRequestError('The saved change and its OneDrive recovery journal do not match. Review both before continuing.');
      }
      if (!pending && item.stage !== 'releasing') {
        if (item.stage === 'archive-writing' || item.stage === 'source-writing') throw new DeckRequestError('The OneDrive recovery journal is missing. Review the pending change.');
        pending = { id: item.id, action: item.operation.action, source: item.operation.source, stage: item.archiveWrite ? 'archive-ready' : 'source-ready', sourceWrite: source, ...(item.archiveWrite ? { archiveWrite: item.archiveWrite } : {}) };
        await journal.claim(pending);
      }
    }

    async function recoverAndPublishArchive() {
      if (item.stage === 'archive-writing') {
        const archive = item.archiveWrite!;
        const current = await currentPlan(archive);
        const result = reviewArchive(item.operation, archive.before ?? '', archive.after, current?.text ?? '');
        if (result === 'needs-review') throw new DeckRequestError('The archive changed while saving. Review the pending removal.');
        await advance({ stage: result === 'satisfied' ? 'source-ready' : 'archive-ready' });
      }
      if (item.stage === 'archive-ready') {
        if (!pending || !item.archiveWrite) throw new Error('Archive stage requires its journal and plan.');
        pending = { ...pending, stage: 'archive-writing' };
        await journal.update(pending);
        await advance({ stage: 'archive-writing' });
        if (item.archiveWrite.id) await validateSourcePath(item.archiveWrite.name, item.archiveWrite.id);
        await publish(item.archiveWrite);
        await advance({ stage: 'source-ready' });
      }
    }

    async function recoverAndPublishSource() {
      const source = item.sourceWrite!;
      if (item.stage === 'source-writing') {
        const current = await currentPlan(source);
        const archive = item.archiveWrite ? await currentPlan(item.archiveWrite) : null;
        const result = reviewSource(item.operation, source.before ?? '', current?.text ?? '', archive?.text ?? '');
        if (result === 'needs-review') throw new DeckRequestError('The save outcome is unclear. Review the current file before continuing.');
        await advance({ stage: result === 'satisfied' ? 'releasing' : 'source-ready' });
      }
      if (item.stage === 'source-ready') {
        if (!pending) throw new Error('Source stage requires its journal.');
        for (let attempt = 0; attempt < 3; attempt++) {
          const plan = item.sourceWrite!;
          pending = { ...pending, stage: 'source-writing' };
          await journal.update(pending);
          await advance({ stage: 'source-writing' });
          if (plan.id) await validateSourcePath(plan.name, plan.id);
          try { await publish(plan); }
          catch (error) {
            if (!(error instanceof GraphError) || error.uncertain || ![409, 412].includes(error.status) || item.operation.action === 'remove' || attempt === 2) throw error;
            const replacement = (await sourcePlan(item.operation)).plan;
            pending = { ...pending, sourceWrite: replacement, stage: 'source-ready' };
            await journal.update(pending);
            await advance({ sourceWrite: replacement, stage: 'source-ready' });
            continue;
          }
          await advance({ stage: 'releasing' });
          break;
        }
      }
    }

    async function finish(): Promise<DeckState> {
      if (item.stage !== 'releasing') throw new Error('Unexpected pending mutation stage.');
      if (pending) await journal.release(item.id);
      const current = await currentPlan(item.sourceWrite!);
      if (!current) throw new DeckRequestError('The saved file is no longer available. Review the pending change.');
      sources.set(item.sourceWrite!.name, current.item);
      return projectOperation(item.snapshot, item.operation, current.revision, current.text);
    }

    try {
      if (isUnchangedEdit(item.operation)) return item.snapshot;
      await preparePlans();
      await reconcileJournal();
      await recoverAndPublishArchive();
      await recoverAndPublishSource();
      return await finish();
    } catch (error) { asDeckError(error); }
    finally { saving = false; }
  }

  async function discard(id: string): Promise<void> {
    const pending = await journal.inspect();
    if (pending?.id === id) await journal.release(id);
  }

  return { load, mutate, pending, recover, clearReviewed, execute, discard };
}

export type OneDriveStore = ReturnType<typeof createOneDriveStore>;
