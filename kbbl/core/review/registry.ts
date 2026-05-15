export interface ReviewRegistryEntry {
  validateAnchor: (anchor: string | null) => true | string;
  exists?: (target_id: string) => boolean | Promise<boolean>;
  responder_id?: string;
}

export class ReviewRegistry {
  private readonly entries = new Map<string, ReviewRegistryEntry>();

  register(target_type: string, entry: ReviewRegistryEntry): void {
    this.entries.set(target_type, entry);
  }

  get(target_type: string): ReviewRegistryEntry | undefined {
    return this.entries.get(target_type);
  }

  isRegistered(target_type: string): boolean {
    return this.entries.has(target_type);
  }
}

export const reviewRegistry = new ReviewRegistry();
