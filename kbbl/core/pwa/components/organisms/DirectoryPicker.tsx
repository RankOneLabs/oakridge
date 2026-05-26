import { useEffect, useState } from "react";

interface DirectoryEntry {
  name: string;
  path: string;
}

interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: DirectoryEntry[];
}

interface DirectoryPickerProps {
  disabled: boolean;
  initialPath: string | null;
  onSelect: (path: string) => void;
}

async function fetchDirectoryListing(path: string | null): Promise<DirectoryListing> {
  const url = path === null ? "/directories" : `/directories?path=${encodeURIComponent(path)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(typeof body?.error === "string" ? body.error : `directories: ${res.status}`);
  }
  return (await res.json()) as DirectoryListing;
}

export function DirectoryPicker({ disabled, initialPath, onSelect }: DirectoryPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setError(null);
    setIsLoading(true);
    void fetchDirectoryListing(pendingPath ?? initialPath)
      .then((nextListing) => {
        if (cancelled) return;
        setListing(nextListing);
        setPendingPath(nextListing.path);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "failed to load directories");
      })
      .finally(() => {
        if (cancelled) return;
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialPath, isOpen, pendingPath]);

  function openAt(path: string | null) {
    setPendingPath(path);
  }

  return (
    <>
      <button
        type="button"
        className="btn-directory-picker"
        disabled={disabled}
        onClick={() => setIsOpen(true)}
      >
        Browse
      </button>
      {isOpen && (
        <div className="directory-picker-layer" role="presentation">
          <div
            className="directory-picker"
            role="dialog"
            aria-modal="true"
            aria-label="Choose workdir"
          >
            <div className="directory-picker-header">
              <div className="directory-picker-path" title={listing?.path ?? ""}>
                {isLoading && listing === null ? "Loading directories" : listing?.path ?? "Choose directory"}
              </div>
              <button
                type="button"
                className="directory-picker-close"
                onClick={() => setIsOpen(false)}
                aria-label="Close directory picker"
                title="Close"
              >
                x
              </button>
            </div>
            {error !== null && (
              <div className="directory-picker-error" role="alert">
                {error}
              </div>
            )}
            <div className="directory-picker-list">
              {listing?.parent !== null && listing?.parent !== undefined && (
                <button
                  type="button"
                  className="directory-picker-row"
                  onClick={() => openAt(listing.parent)}
                >
                  <span className="directory-picker-name">..</span>
                  <span className="directory-picker-subpath">{listing.parent}</span>
                </button>
              )}
              {listing?.entries.map((entry) => (
                <button
                  type="button"
                  key={entry.path}
                  className="directory-picker-row"
                  onClick={() => openAt(entry.path)}
                  onDoubleClick={() => {
                    onSelect(entry.path);
                    setIsOpen(false);
                  }}
                >
                  <span className="directory-picker-name">{entry.name}</span>
                  <span className="directory-picker-subpath">{entry.path}</span>
                </button>
              ))}
            </div>
            <div className="directory-picker-actions">
              <button
                type="button"
                className="directory-picker-cancel"
                onClick={() => setIsOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="directory-picker-select"
                disabled={listing === null || isLoading}
                onClick={() => {
                  if (listing === null) return;
                  onSelect(listing.path);
                  setIsOpen(false);
                }}
              >
                Use directory
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
