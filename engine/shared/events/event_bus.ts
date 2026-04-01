export type EventCallback<T = any> = (data: T) => void;

/**
 * Generic typed event bus with optional strict mode.
 * When validEvents is set, emitting or listening to an unknown event throws an error.
 */
export class EventBus<TEventMap extends Record<string, any> = Record<string, any>> {
  readonly channel: string;
  private listeners = new Map<string, Array<EventCallback>>();
  private entityListeners = new Map<number, Array<{ event: string; callback: EventCallback }>>();
  private emitDepth = 0;
  private validEvents: Set<string> | null = null;

  onEmit: ((event: string, data: any) => void) | null = null;
  getCurrentEntityId: (() => number) | null = null;

  constructor(channel: string = '') {
    this.channel = channel;
  }

  /** Set valid event names. Once set, emitting or listening to unknown events throws. */
  setValidEvents(events: Set<string>): void {
    this.validEvents = events;
  }

  private checkEvent(event: string): void {
    if (this.validEvents && !this.validEvents.has(event)) {
      throw new Error(`[${this.channel}] Unknown event "${event}". Valid events: ${[...this.validEvents].slice(0, 10).join(', ')}...`);
    }
  }

  on<K extends keyof TEventMap & string>(event: K, cb: EventCallback<TEventMap[K]>): void {
    this.checkEvent(event);
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
    this.checkEvent(event);
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

  clear(): void {
    this.listeners.clear();
    this.entityListeners.clear();
  }
}
