// Polyfills required by ReactFlow in jsdom.

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverMock;

// ReactFlow uses DOMMatrix for transforms.
if (typeof global.DOMMatrix === "undefined") {
  // @ts-expect-error minimal stub
  global.DOMMatrix = class {
    constructor() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; }
  };
}

// Suppress ReactFlow's "width/height" warnings in test output.
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (
    typeof args[0] === "string" &&
    (args[0].includes("ResizeObserver") || args[0].includes("width"))
  ) {
    return;
  }
  consoleError(...args);
};
