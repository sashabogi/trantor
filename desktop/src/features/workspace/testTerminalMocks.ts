import { vi } from "vitest";

export const emitAttachedBytes: { current: ((bytes: number[]) => void) | null } = { current: null };
export const resizeObserverInstances: MockResizeObserver[] = [];

let currentTerminal: MockTerminal | null = null;

export function lastTerminal(): MockTerminal | null {
  return currentTerminal;
}

export function resetTerminalMocks() {
  emitAttachedBytes.current = null;
  resizeObserverInstances.length = 0;
  currentTerminal = null;
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
}

export class MockFitAddon {
  fit = vi.fn();
  dispose = vi.fn();
}

export class MockWebglAddon {
  dispose = vi.fn();
}

export class MockTerminal {
  cols = 100;
  rows = 30;
  writes: Uint8Array[] = [];
  loaded: unknown[] = [];
  private dataHandler: ((data: string) => void) | null = null;

  constructor() {
    currentTerminal = this;
  }

  loadAddon(addon: unknown) {
    this.loaded.push(addon);
  }

  open() {}

  write(data: Uint8Array) {
    this.writes.push(data);
  }

  writeln(data: string) {
    this.writes.push(new TextEncoder().encode(data));
  }

  onData(handler: (data: string) => void) {
    this.dataHandler = handler;
    return { dispose: vi.fn() };
  }

  emitData(data: string) {
    this.dataHandler?.(data);
  }

  dispose() {}
}

export class MockResizeObserver {
  constructor(private readonly cb: ResizeObserverCallback) {
    resizeObserverInstances.push(this);
  }

  observe = vi.fn();
  disconnect = vi.fn();

  fire() {
    this.cb([], this as unknown as ResizeObserver);
  }
}
