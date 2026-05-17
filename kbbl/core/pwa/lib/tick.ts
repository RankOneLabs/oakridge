type Listener = () => void;
const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;

function start() {
  if (timer !== null) return;
  timer = setInterval(() => {
    for (const l of listeners) {
      try { l(); } catch { /* keep ticker alive for other subscribers */ }
    }
  }, 60_000);
}

function stop() {
  if (timer === null || listeners.size > 0) return;
  clearInterval(timer);
  timer = null;
}

export function subscribeTick(l: Listener): () => void {
  listeners.add(l);
  start();
  return () => {
    listeners.delete(l);
    stop();
  };
}
