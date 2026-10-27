/**
 * Stub for the Iron Remote Desktop web component packages. The real ones load WebAssembly and
 * register a custom element that talks to a live RDP proxy, so tests get the surface only.
 */

interface Disposable {
  dispose: () => void;
}

const nothing = (): Disposable => ({ dispose: () => undefined });

export const rdpBackend = { kind: 'rdp-test-backend' };
export default rdpBackend;

/** The engine's WebAssembly setup, which resolves straight away here. */
export async function init(): Promise<void> {
  return undefined;
}

export function preConnectionBlob(): string {
  return '';
}

/** The element the renderer mounts. Records what it was asked to do. */
export class IronRemoteDesktopStub extends HTMLElement {
  calls: { name: string; args: unknown[] }[] = [];

  connect(...args: unknown[]): { onConnected: typeof nothing } {
    this.calls.push({ name: 'connect', args });
    return { onConnected: nothing };
  }
  shutdown(): void {
    this.calls.push({ name: 'shutdown', args: [] });
  }
  setKeyboardUnicodeMode(): void {
    return undefined;
  }
  setCursorStyleOverride(): void {
    return undefined;
  }
  onSessionEvent = nothing;
  onActiveSessionChange = nothing;
}

if (typeof customElements !== 'undefined' && !customElements.get('iron-remote-desktop-test')) {
  customElements.define('iron-remote-desktop-test', IronRemoteDesktopStub);
}

export const loggingLevel = { info: 'info', debug: 'debug' };

/** What the fake DeviceEvent statics return: plain objects tagged with the call that made them. */
export type FakeDeviceEvent =
  | { type: 'mouseMove'; x: number; y: number }
  | { type: 'mouseButtonPressed' | 'mouseButtonReleased'; button: number }
  | { type: 'keyPressed' | 'keyReleased'; scancode: number }
  | { type: 'unicodePressed' | 'unicodeReleased'; char: string }
  | { type: 'wheelRotations'; vertical: boolean; amount: number; unit: number };

export class FakeInputTransaction {
  events: FakeDeviceEvent[] = [];
  addEvent(event: FakeDeviceEvent): void {
    this.events.push(event);
  }
}

/** Stands in for the engine's `Session`: records the input it is given. */
export class FakeSession {
  transactions: FakeInputTransaction[] = [];
  releasedAll = 0;
  size = { width: 1920, height: 1080 };
  applyInputs(transaction: FakeInputTransaction): void {
    this.transactions.push(transaction);
  }
  releaseAllInputs(): void {
    this.releasedAll++;
  }
  desktopSize(): { width: number; height: number } {
    return { ...this.size };
  }
}

/** Stands in for the engine's `ClipboardData`: a list of MIME type and value pairs. */
export class FakeClipboardData {
  entries: { mimeType: string; value: string | Uint8Array }[] = [];
  addText(mimeType: string, text: string): void {
    this.entries.push({ mimeType, value: text });
  }
  addBinary(mimeType: string, binary: Uint8Array): void {
    this.entries.push({ mimeType, value: binary });
  }
  isEmpty(): boolean {
    return this.entries.length === 0;
  }
  items(): { mimeType: () => string; value: () => string | Uint8Array }[] {
    return this.entries.map((entry) => ({
      mimeType: () => entry.mimeType,
      value: () => entry.value,
    }));
  }
}

/** Stands in for the engine's `SessionBuilder`. Builder calls chain; connect hands back a session. */
export class FakeSessionBuilder {
  calls: string[] = [];
  session = new FakeSession();
  /** What the engine would call when the server's clipboard changes. */
  remoteClipboardChanged: ((data: FakeClipboardData) => void) | null = null;
  renderCanvas(): this {
    this.calls.push('renderCanvas');
    return this;
  }
  remoteClipboardChangedCallback(callback: (data: FakeClipboardData) => void): this {
    this.calls.push('remoteClipboardChangedCallback');
    this.remoteClipboardChanged = callback;
    return this;
  }
  async connect(): Promise<FakeSession> {
    this.calls.push('connect');
    return this.session;
  }
}

export const FakeDeviceEvent = {
  mouseMove: (x: number, y: number): FakeDeviceEvent => ({ type: 'mouseMove', x, y }),
  mouseButtonPressed: (button: number): FakeDeviceEvent => ({ type: 'mouseButtonPressed', button }),
  mouseButtonReleased: (button: number): FakeDeviceEvent => ({
    type: 'mouseButtonReleased',
    button,
  }),
  keyPressed: (scancode: number): FakeDeviceEvent => ({ type: 'keyPressed', scancode }),
  keyReleased: (scancode: number): FakeDeviceEvent => ({ type: 'keyReleased', scancode }),
  unicodePressed: (char: string): FakeDeviceEvent => ({ type: 'unicodePressed', char }),
  unicodeReleased: (char: string): FakeDeviceEvent => ({ type: 'unicodeReleased', char }),
  wheelRotations: (vertical: boolean, amount: number, unit: number): FakeDeviceEvent => ({
    type: 'wheelRotations',
    vertical,
    amount,
    unit,
  }),
};

/** The engine's `Backend` namespace, with recording fakes in place of the WebAssembly classes. */
export const Backend = {
  DesktopSize: class {
    constructor(
      public width: number,
      public height: number,
    ) {}
  },
  InputTransaction: FakeInputTransaction,
  SessionBuilder: FakeSessionBuilder,
  ClipboardData: FakeClipboardData,
  DeviceEvent: FakeDeviceEvent,
};
