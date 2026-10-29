import { DeckRequestError } from '../deck-client';

const PICKER_ORIGIN = 'https://onedrive.live.com';

export interface PickedFolder { id: string; driveId: string }

function pickerOptions(channelId: string) {
  return {
    sdk: '8.0', entry: { oneDrive: { files: {} } }, authentication: {},
    messaging: { origin: location.origin, channelId },
    typesAndSources: { mode: 'folders', locations: { oneDrive: {} } },
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

/** Run the hosted picker in the supplied frame until selection or cancellation. */
export function openOneDrivePicker(frame: HTMLIFrameElement, signal: AbortSignal, getToken: () => Promise<string>, select: (folder: PickedFolder) => Promise<void>): Promise<void> {
  const channelId = crypto.randomUUID();
  frame.name = `onedrive-picker-${channelId}`;
  return new Promise((resolve, reject) => {
    let port: MessagePort | undefined;
    let finished = false;
    let selecting = false;
    function cancel() { if (!selecting) succeed(); }
    function cleanup() {
      finished = true;
      signal.removeEventListener('abort', cancel);
      window.removeEventListener('message', initialize);
      port?.close();

    }
    function succeed() { if (!finished) { cleanup(); resolve(); } }
    function fail(error: unknown) { if (!finished) { cleanup(); reject(error); } }
    function reply(activePort: MessagePort, id: unknown, data: object) {
      activePort.postMessage({ type: 'result', id, data });
    }
    async function handleSelection(activePort: MessagePort, id: unknown, items: unknown) {
      if (selecting) throw new DeckRequestError('A folder selection is already in progress.');
      selecting = true;
      await select(selectedFolder(items));
      reply(activePort, id, { result: 'success' });
      succeed();
    }
    async function command(event: MessageEvent) {
      const message = event.data;
      if (message?.type !== 'command' || !port) return;
      const activePort = port;
      activePort.postMessage({ type: 'acknowledge', id: message.id });
      try {
        switch (message.data?.command) {
          case 'authenticate': reply(activePort, message.id, { result: 'token', token: await getToken() }); break;
          case 'pick': await handleSelection(activePort, message.id, message.data.items); break;
          case 'close': if (!selecting) succeed(); break;
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
    }
    window.addEventListener('message', initialize);
    signal.addEventListener('abort', cancel);
    if (signal.aborted) cancel();
    void getToken().then(token => { if (!finished) submitPicker(frame, channelId, token); }).catch(fail);
  });
}
