/**
 * Produces incrementing integer IDs for entities within a scene.
 * Supports free-list recycling of released IDs.
 */
export class IdAllocator {
    private nextId: number = 1;
    private freedIds: number[] = [];

    /** Allocate the next unique integer ID. Reuses freed IDs when available. */
    allocate(): number {
        if (this.freedIds.length > 0) {
            return this.freedIds.pop()!;
        }
        return this.nextId++;
    }

    /** Return an ID to the pool for potential reuse. */
    free(id: number): void {
        this.freedIds.push(id);
    }

    /** Reset the counter and free list. Only safe to call between scenes. */
    reset(): void {
        this.nextId = 1;
        this.freedIds.length = 0;
    }

    /** Ensure that the internal counter is at least `minId`. Used when restoring scenes. */
    ensureMinimum(minId: number): void {
        if (this.nextId <= minId) {
            this.nextId = minId + 1;
        }
    }
}

/**
 * Generates RFC 4122 v4 UUIDs for asset references.
 * Uses crypto.randomUUID() when available, with a manual fallback.
 */
export function generateUUID(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}
