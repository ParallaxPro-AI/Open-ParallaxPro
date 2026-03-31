import { EventBus } from './event_bus.js';
import type {
  CoreEvents, GameEvents, AudioEvents, UIEvents,
  InputEvents, PhysicsEvents, NetworkEvents, SceneEvents,
} from './event_types.js';

/**
 * Central event registry holding all typed event buses.
 * Created per play session; cleared on stop.
 *
 * The `game` bus is loosely typed for game-specific events.
 * Engine-level buses (audio, physics, network, etc.) are strongly typed.
 */
export class EventRegistry {
  readonly core = new EventBus<CoreEvents>('core');
  readonly game = new EventBus<GameEvents>('game');
  readonly audio = new EventBus<AudioEvents>('audio');
  readonly ui = new EventBus<UIEvents>('ui');
  readonly input = new EventBus<InputEvents>('input');
  readonly physics = new EventBus<PhysicsEvents>('physics');
  readonly network = new EventBus<NetworkEvents>('network');
  readonly scene = new EventBus<SceneEvents>('scene');

  private readonly buses: EventBus<any>[];

  constructor() {
    this.buses = [
      this.core, this.game, this.audio, this.ui,
      this.input, this.physics, this.network, this.scene,
    ];
  }

  /** Get a bus by channel name (e.g. "game", "audio"). */
  getBus(name: string): EventBus<any> | undefined {
    return (this as any)[name] as EventBus<any> | undefined;
  }

  /** Wire up all buses with shared hooks. */
  configure(opts: {
    getCurrentEntityId?: () => number;
    onEmit?: (channel: string, event: string, data: any) => void;
  }): void {
    for (const bus of this.buses) {
      if (opts.getCurrentEntityId) bus.getCurrentEntityId = opts.getCurrentEntityId;
      if (opts.onEmit) {
        const ch = bus.channel;
        bus.onEmit = (event, data) => opts.onEmit!(ch, event, data);
      }
    }
  }

  /** Remove all listeners registered by a specific entity from all buses. */
  cleanupEntity(entityId: number): void {
    for (const bus of this.buses) bus.cleanupEntity(entityId);
  }

  /** Clear all listeners on all buses. */
  clear(): void {
    for (const bus of this.buses) bus.clear();
  }
}
