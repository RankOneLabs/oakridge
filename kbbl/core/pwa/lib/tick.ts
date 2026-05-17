type Listener = () => void;
const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;

function start() {
  if (timer !== null) return;
  timer = setInterval(() => { for (const l of listeners) l(); }, 1000);
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
