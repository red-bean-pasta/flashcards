import { CardParseError } from '../card-ranges.js';
import { appendEntry, CardInputError } from '../card-text.js';
import { parseBrowserCards } from '../browser-cards.js';
import { DeckRequestError } from '../deck-client.js';
import type { DeckState, MutationRequest } from '../types.js';
import { GraphError, type GraphClient, type GraphItem } from './graph.js';
import { OneDriveAuthError } from './auth.js';
import { createOperationJournal, type PendingOperation, type WritePlan } from './journal.js';
import { captureOperation, planContent, createOperationProjector, type CardOperation } from './operations.js';

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

  async function scan(id: string, prefix = '', ancestors = new Set<string>()): Promise<void> {
    if (ancestors.has(id)) throw new DeckRequestError('OneDrive returned a recursive folder.');
    const nextAncestors = new Set([...ancestors, id]);
    for (const item of await graph.children(id)) {
      if (item.name.startsWith('.') || item.name.toLowerCase() === 'removed.md') continue;
      const source = prefix + item.name;
      if (item.folder) await scan(item.id, source + '/', nextAncestors);
      else if (item.file && /\.md$/i.test(item.name)) sources.set(source, item);
    }
  }

  async function load(): Promise<DeckState> {
    try {
      sources.clear();
      await scan(folder.id);
      const cards: DeckState['cards'] = [];
      const errors: string[] = [];
      const revisions: Record<string, string> = {};
      for (const [source, item] of sources) {
        try {
          const snapshot = await graph.readText(item.id);
          cards.push(...parse(snapshot.text, source));
          revisions[source] = snapshot.revision;
        } catch (error) {
          if (!(error instanceof CardParseError)) throw error;
          errors.push(error.message);
        }
      }
      return { cards: errors.length ? [] : cards, files: [...sources.keys()].sort(), revisions, errors };
    } catch (error) { asDeckError(error); }
  }

  async function sourcePlan(operation: CardOperation): Promise<{ plan: WritePlan; removed: string }> {
    let item = sources.get(operation.source);
    if (!item) {
      if (operation.action !== 'add') throw new DeckRequestError('This card file is no longer available. Refresh to review your notes.');
      if (!/^[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)*\.md$/u.test(operation.source)) throw new DeckRequestError('New filenames must use file_name.md without a folder path.');
      item = await graph.findChild(folder.id, operation.source) ?? undefined;
      if (item && !item.file) throw new DeckRequestError('That name belongs to a folder. Choose another filename.');
      if (item) sources.set(operation.source, item);
    }
    const before = item ? await graph.readText(item.id) : null;
    const change = planContent(before?.text ?? '', operation);
    return { plan: { id: item?.id ?? null, name: operation.source, before: before?.text ?? null, revision: before?.revision ?? null, after: change.text }, removed: change.removed };
  }

  async function archivePlan(removed: string): Promise<WritePlan> {
    const item = await graph.findChild(folder.id, 'removed.md');
    if (item && !item.file) throw new DeckRequestError('removed.md is not a file. The source was not removed.');
    const before = item ? await graph.readText(item.id) : null;
    if (before) parse(before.text, 'removed.md');
    const eol = before?.text.match(/\r\n|\r|\n/)?.[0] ?? removed.match(/\r\n|\r|\n/)?.[0] ?? '\n';
    const after = appendEntry(before?.text ?? '', removed, eol);
    parse(after, 'removed.md');
    return { id: item?.id ?? null, name: 'removed.md', before: before?.text ?? null, revision: before?.revision ?? null, after };
  }

  async function publish(plan: WritePlan): Promise<GraphItem> {
    if (plan.id !== null) {
      if (plan.revision === null) throw new Error('Existing-file write plan requires an eTag.');
      return graph.replaceText(plan.id, plan.revision, plan.after);
    }
    return graph.createFile(folder.id, plan.name, plan.after);
  }

  async function performSource(pending: PendingOperation, operation: CardOperation): Promise<{ item: GraphItem; text: string }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await journal.update({ ...pending, stage: 'source-writing' });
      try { return { item: await publish(pending.sourceWrite), text: pending.sourceWrite.after }; }
      catch (error) {
        if (!(error instanceof GraphError) || error.uncertain || ![409, 412].includes(error.status)) throw error;
        // Archival is already confirmed for Remove: do not archive a new set of
        // occurrences or erase a competing edit while recovering a partial removal.
        if (operation.action === 'remove') throw new DeckRequestError('The card file changed after archival. Your original entries are safe in removed.md. Review the pending removal before continuing.', { cause: error });
        if (attempt === 2) throw new DeckRequestError('The file kept changing. Review the pending save before trying again.', { cause: error });
        pending = { ...pending, sourceWrite: (await sourcePlan(operation)).plan, stage: 'source-ready' };
        await journal.update(pending);
      }
    }
    throw new Error('Unreachable conditional-write retry state.');
  }

  async function mutate(request: MutationRequest, deck: DeckState): Promise<DeckState> {
    if (saving) throw new Error('Concurrent mutation submitted to one browser store.');
    saving = true;
    try {
      const operation = captureOperation(deck, request);
      const { plan, removed } = await sourcePlan(operation);
      const archive = operation.action === 'remove' ? await archivePlan(removed) : undefined;
      const pending: PendingOperation = {
        id: crypto.randomUUID(), action: operation.action, source: operation.source,
        stage: archive ? 'archive-ready' : 'source-ready', sourceWrite: plan,
        ...(archive ? { archiveWrite: archive } : {}),
      };
      await journal.claim(pending);
      if (archive) {
        await journal.update({ ...pending, stage: 'archive-writing' });
        await publish(archive);
        pending.stage = 'source-ready';
        await journal.update(pending);
      }
      const { item: result, text } = await performSource(pending, operation);
      await journal.release(pending.id);
      if (!result.eTag) throw new Error('Graph transport returned a saved file without an eTag.');
      sources.set(operation.source, result);
      return projectOperation(deck, operation, result.eTag, text);
    } catch (error) { asDeckError(error); }
    finally { saving = false; }
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

  return { load, mutate, pending, recover, clearReviewed };
}

export type OneDriveStore = ReturnType<typeof createOneDriveStore>;
