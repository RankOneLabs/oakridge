import { useEffect, useRef, useState } from "react";

import type { DirectoryListing } from "../../../directories";

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
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setError(null);
    setIsLoading(true);
    void fetchDirectoryListing(pendingPath)
      .then((nextListing) => {
        if (cancelled) return;
        setListing(nextListing);
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
  }, [isOpen, pendingPath]);

  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const first = panelRef.current?.querySelector<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    first?.focus();
    return () => {
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setIsOpen(false);
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen]);

  function openAt(path: string | null) {
    setPendingPath(path);
  }

  function openPicker() {
    setListing(null);
    setPendingPath(initialPath);
    setIsOpen(true);
  }

  function handlePanelKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const focusable = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (focusable.length === 1) {
      e.preventDefault();
      first.focus();
      return;
    }
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
      return;
    }
    if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn-directory-picker"
        disabled={disabled}
        onClick={openPicker}
      >
        Browse
      </button>
      {isOpen && (
        <div
          className="directory-picker-layer"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setIsOpen(false);
          }}
        >
          <div
            ref={panelRef}
            className="directory-picker"
            role="dialog"
            aria-modal="true"
            aria-label="Choose workdir"
            onKeyDown={handlePanelKeyDown}
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
              {listing !== null && listing.parent !== null && (
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
