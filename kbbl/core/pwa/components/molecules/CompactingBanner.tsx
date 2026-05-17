import { type Ref } from "react";

export function CompactingBanner({ ref }: { ref?: Ref<HTMLDivElement> }) {
  return (
    <div className="compacting-banner" ref={ref}>
      <span className="compacting-banner__dot" aria-hidden="true" />
      <span className="compacting-banner__dot" aria-hidden="true" />
      <span className="compacting-banner__dot" aria-hidden="true" />
      <span className="compacting-banner__label" role="status" aria-live="polite">
        compacting…
      </span>
      <span className="compacting-banner__hint">
        building handoff doc · successor will spawn when complete
      </span>
    </div>
  );
}
