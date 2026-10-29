import { DeckRequestError } from '../deck-client';

const PICKER_ORIGIN = 'https://onedrive.live.com';

export interface PickedFolder { id: string; driveId: string }

function pickerOptions(channelId: string) {
  return {
    sdk: '8.0', entry: { oneDrive: { files: {} } }, authentication: {},
    messaging: { origin: location.origin, channelId },
    typesAndSources: { mode: 'folders', locations: { oneDrive: {} } },
    accessibility: { trapFocusOnLoad: false },
    selection: { mode: 'single' }, commands: { switchAccount: { mode: 'none' } },
  };
}

function submitPicker(frame: HTMLIFrameElement, channelId: string, token: string) {
  const url = new URL('/picker', PICKER_ORIGIN);
  url.searchParams.set('filePicker', JSON.stringify(pickerOptions(channelId)));
  const form = document.createElement('form');
  form.method = 'POST'; form.action = url.href; form.target = frame.name;
  const input = document.createElement('input');
  input.type = 'hidden'; input.name = 'access_token'; input.value = token;
  form.append(input); document.body.append(form);
  try { form.submit(); } finally { form.remove(); }
}

function selectedFolder(items: unknown): PickedFolder {
  if (!Array.isArray(items) || items.length !== 1 || typeof items[0]?.id !== 'string' || !items[0].id
      || typeof items[0]?.parentReference?.driveId !== 'string' || !items[0].parentReference.driveId) {
    throw new DeckRequestError('Microsoft returned an invalid folder selection.');
  }
  return { id: items[0].id, driveId: items[0].parentReference.driveId };
}

/** Keep one hosted picker and its messaging channel alive until disposed. */
export function createOneDrivePicker(frame: HTMLIFrameElement, getToken: () => Promise<string>, select: (folder: PickedFolder) => Promise<void>, onClose: () => void, onError: (error: unknown) => void, onSelected: () => void, onReady: () => void) {
  const channelId = crypto.randomUUID();
  frame.name = `onedrive-picker-${channelId}`;
  let port: MessagePort | undefined;
  let disposed = false;
  let selecting = false;

  function dispose() {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('message', initialize);
    port?.close();
  }
  function fail(error: unknown) { if (!disposed) { dispose(); onError(error); } }
  function reply(activePort: MessagePort, id: unknown, data: object) {
    activePort.postMessage({ type: 'result', id, data });
  }
  async function handleSelection(activePort: MessagePort, id: unknown, items: unknown) {
    if (selecting) throw new DeckRequestError('A folder selection is already in progress.');
    selecting = true;
    try {
      await select(selectedFolder(items));
      reply(activePort, id, { result: 'success' });
    } finally { selecting = false; }
    onSelected();
  }
  async function command(event: MessageEvent) {
    const message = event.data;
    if (message?.type !== 'command' || !port || disposed) return;
    const activePort = port;
    activePort.postMessage({ type: 'acknowledge', id: message.id });
    try {
      switch (message.data?.command) {
        case 'authenticate': reply(activePort, message.id, { result: 'token', token: await getToken() }); break;
        case 'pick': await handleSelection(activePort, message.id, message.data.items); break;
        case 'close': if (!selecting) onClose(); break;
        default: reply(activePort, message.id, { result: 'error', error: { code: 'unsupportedCommand', message: `Unsupported picker command: ${String(message.data?.command)}` } });
      }
    } catch (error) {
      reply(activePort, message.id, { result: 'error', error: { code: 'unableToProcess', message: error instanceof Error ? error.message : 'The OneDrive picker failed.' } });
      fail(error);
    }
  }
  function initialize(event: MessageEvent) {
    if (event.origin !== PICKER_ORIGIN || event.source !== frame.contentWindow || event.data?.type !== 'initialize' || event.data.channelId !== channelId || !event.ports[0]) return;
    port?.close();
    port = event.ports[0];
    port.addEventListener('message', event => { void command(event); });
    port.start();
    port.postMessage({ type: 'activate' });
    onReady();
  }
  window.addEventListener('message', initialize);
  void getToken().then(token => { if (!disposed) submitPicker(frame, channelId, token); }).catch(fail);
  return { dispose, isSelecting: () => selecting };
}
