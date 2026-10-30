import { archiveFilename } from '../card-text.js';
import { DeckRequestError } from '../deck-client.js';
import { GraphError } from './graph.js';
import type { GraphClient } from './graph.js';

export interface WritePlan {
  id: string | null;
  name: string;
  before: string | null;
  revision: string | null;
  after: string;
}
export interface PendingOperation {
  id: string;
  source: string;
  action: 'add' | 'edit' | 'remove';
  stage: 'archive-ready' | 'archive-writing' | 'source-ready' | 'source-writing';
  sourceWrite: WritePlan;
  archiveWrite?: WritePlan;
}
export interface JournalDocument { version: 1; operation: PendingOperation | null }

const JOURNAL_NAME = '.flashcards-operation.json';
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const filename = (value: unknown): value is string => nonempty(value) && !/[\\/\u0000]/.test(value) && value !== '.' && value !== '..';

function relativePath(value: unknown): value is string {
  return nonempty(value) && value.split('/').every(filename);
}

function validPlan(value: unknown): value is WritePlan {
  if (!record(value) || !relativePath(value.name) || typeof value.after !== 'string') return false;
  if (value.id === null) return filename(value.name) && value.before === null && value.revision === null;
  return nonempty(value.id) && typeof value.before === 'string' && nonempty(value.revision);
}

function validOperation(value: unknown): value is PendingOperation {
  if (!record(value) || !nonempty(value.id) || !relativePath(value.source) || !validPlan(value.sourceWrite) || value.sourceWrite.name !== value.source) return false;
  if (!['add', 'edit', 'remove'].includes(value.action as string) || !['archive-ready', 'archive-writing', 'source-ready', 'source-writing'].includes(value.stage as string)) return false;
  if (value.action === 'remove') {
    return value.sourceWrite.id !== null && validPlan(value.archiveWrite) && value.archiveWrite.name === archiveFilename && value.archiveWrite.name !== value.source &&
      (value.archiveWrite.id === null || value.archiveWrite.id !== value.sourceWrite.id);
  }
  return value.archiveWrite === undefined && (value.action !== 'edit' || value.sourceWrite.id !== null) &&
    (value.stage === 'source-ready' || value.stage === 'source-writing');
}

function parseDocument(text: string): JournalDocument {
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new DeckRequestError('The OneDrive operation journal contains invalid JSON. Review it before saving.', { cause: error });
  }
  if (!record(value) || value.version !== 1 || !(value.operation === null || validOperation(value.operation))) {
    throw new DeckRequestError('The OneDrive operation journal has an invalid structure. Review it before saving.', { cause: new Error('Invalid version, operation, stage, or write plan in journal.') });
  }
  return value as unknown as JournalDocument;
}

function pendingError(cause?: unknown): DeckRequestError {
  return new DeckRequestError('A pending OneDrive save needs review. Refresh and review the current files before saving again.', cause === undefined ? undefined : { cause });
}

interface Snapshot { fileId: string; revision: string; text: string; document: JournalDocument }

/** The journal records intent only. It never executes or infers success of a target write. */
export function createOperationJournal(graph: GraphClient, folderId: string) {
  let observedOwner: string | null = null;

  async function readJournal(): Promise<Snapshot | null> {
    const item = await graph.findChild(folderId, JOURNAL_NAME);
    if (!item) return null;
    if (!item.file || item.folder) throw new DeckRequestError('The OneDrive operation journal is not a file.', { cause: new Error('Journal item lacks a file facet.') });
    const current = await graph.readText(item.id);
    return { fileId: current.id, revision: current.revision, text: current.text, document: parseDocument(current.text) };
  }

  function assertObservedOwner(id: string): void {
    if (!id || observedOwner !== id) throw new Error('Journal mutation requires the operation last inspected or claimed by this client.');
  }

  async function requireCurrentOwner(id: string): Promise<Snapshot> {
    const current = await readJournal();
    if (!current || current.document.operation?.id !== id) throw pendingError();
    return current;
  }

  async function confirmJournalWrite(text: string, cause: GraphError): Promise<void> {
    let current: Snapshot | null;
    try { current = await readJournal(); } catch (error) {
      if (!(error instanceof GraphError) && !(error instanceof DeckRequestError)) throw error;
      throw new DeckRequestError('The operation journal save outcome is unknown. Refresh and review pending saves before continuing.', { cause: new AggregateError([cause, error], 'Journal write and confirmation failed.') });
    }
    if (!current || current.text !== text) {
      throw new DeckRequestError('The operation journal save outcome is unknown. Refresh and review pending saves before continuing.', { cause });
    }
  }

  async function writeDocument(current: Snapshot | null, document: JournalDocument): Promise<void> {
    const text = JSON.stringify(document);
    try {
      if (current) await graph.replaceText(current.fileId, current.revision, text);
      else await graph.createFile(folderId, JOURNAL_NAME, text);
    } catch (error) {
      if (!(error instanceof GraphError)) throw error;
      if (error.uncertain) return confirmJournalWrite(text, error);
      if (error.status === 409 || error.status === 412) throw pendingError(error);
      throw error;
    }
  }

  return {
    async inspect(): Promise<PendingOperation | null> {
      const operation = (await readJournal())?.document.operation ?? null;
      observedOwner = operation?.id ?? null;
      return operation;
    },
    async claim(operation: PendingOperation): Promise<void> {
      if (!validOperation(operation)) throw new Error('Cannot claim an invalid operation plan.');
      const current = await readJournal();
      if (current?.document.operation) throw pendingError();
      await writeDocument(current, { version: 1, operation });
      observedOwner = operation.id;
    },
    async update(operation: PendingOperation): Promise<void> {
      if (!validOperation(operation)) throw new Error('Cannot update an invalid operation plan.');
      assertObservedOwner(operation.id);
      const current = await requireCurrentOwner(operation.id);
      await writeDocument(current, { version: 1, operation });
    },
    async release(operationId: string): Promise<void> {
      assertObservedOwner(operationId);
      const current = await requireCurrentOwner(operationId);
      await writeDocument(current, { version: 1, operation: null });
      observedOwner = null;
    },
  };
}
