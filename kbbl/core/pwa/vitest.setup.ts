// Polyfills required by ReactFlow in jsdom.

// window.matchMedia is not implemented in jsdom; stub it for useViewport and any
// other media-query consumers added by cohort-2.
if (typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

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
    (args[0].includes("ResizeObserver") ||
      args[0].includes("ReactFlow: The parent container needs a width"))
  ) {
    return;
  }
  consoleError(...args);
};
