export type EventCallback<T = any> = (data: T) => void;

/**
 * Generic typed event bus. Each bus handles one domain (e.g. combat, audio).
 * The type parameter maps event names to payload types for compile-time safety.
 */
export class EventBus<TEventMap extends Record<string, any> = Record<string, any>> {
  readonly channel: string;
  private listeners = new Map<string, Array<EventCallback>>();
  private entityListeners = new Map<number, Array<{ event: string; callback: EventCallback }>>();
  private emitDepth = 0;

  /** Optional hook called on every emit (useful for logging or testing). */
  onEmit: ((event: string, data: any) => void) | null = null;

  /** Optional hook returning the current executing entity ID for auto-cleanup tracking. */
  getCurrentEntityId: (() => number) | null = null;

  constructor(channel: string = '') {
    this.channel = channel;
  }

  on<K extends keyof TEventMap & string>(event: K, cb: EventCallback<TEventMap[K]>): void {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(cb as EventCallback);

    const eid = this.getCurrentEntityId?.() ?? -1;
    if (eid >= 0) {
      if (!this.entityListeners.has(eid)) this.entityListeners.set(eid, []);
      this.entityListeners.get(eid)!.push({ event, callback: cb as EventCallback });
    }
  }

  off<K extends keyof TEventMap & string>(event: K, cb: EventCallback<TEventMap[K]>): void {
    const arr = this.listeners.get(event);
    if (arr) {
      const idx = arr.indexOf(cb as EventCallback);
      if (idx >= 0) arr.splice(idx, 1);
    }
  }

  emit<K extends keyof TEventMap & string>(event: K, data?: TEventMap[K]): void {
    if (this.emitDepth > 20) {
      console.warn(`[${this.channel}] Event recursion depth exceeded for '${event}'`);
      return;
    }
    this.emitDepth++;
    this.onEmit?.(event, data);
    const arr = this.listeners.get(event);
    if (arr) {
      for (const fn of [...arr]) {
        try {
          fn(data);
        } catch (e) {
          console.error(`[${this.channel}] Error in '${event}':`, e);
        }
      }
    }
    this.emitDepth--;
  }

  /** Remove all listeners registered by a specific entity. */
  cleanupEntity(entityId: number): void {
    const tracked = this.entityListeners.get(entityId);
    if (!tracked) return;
    for (const { event, callback } of tracked) {
      const arr = this.listeners.get(event);
      if (arr) {
        const idx = arr.indexOf(callback);
        if (idx >= 0) arr.splice(idx, 1);
      }
    }
    this.entityListeners.delete(entityId);
  }

  /** Remove all listeners. */
  clear(): void {
    this.listeners.clear();
    this.entityListeners.clear();
  }
}
