// Core engine lifecycle events
export interface CoreEvents {
  stateChanged: { state: string; previous?: string; entityId?: number };
}

// General-purpose game events (loosely typed for flexibility)
export interface GameEvents {
  [key: string]: any;
}

// Audio system events
export interface AudioEvents {
  playSound: { path: string; volume?: number; loop?: boolean; entityId?: number };
  playMusic: { path?: string; track?: string; volume?: number };
  stopMusic: {};
  stopSound: {};
  setMusicVolume: { volume: number };
  setSfxVolume: { volume: number };
  setMasterVolume: { volume: number };
}

// UI events
export interface UIEvents {
  showNotification: { text: string; duration?: number };
  showUi: { panel: string };
  hideUi: { panel: string };
  hudUpdate: { [key: string]: any };
  [key: string]: any;
}

// Input interaction events
export interface InputEvents {
  interactionStarted: { entityId?: number; type?: string };
  interactionComplete: { entityId?: number };
}

// Physics command events
export interface PhysicsEvents {
  setVelocity: { entity: string; x: number; y: number; z: number };
  knockback: { entityId?: number; x?: number; y?: number; z?: number };
}

// Network multiplayer events
export interface NetworkEvents {
  playerJoined: { playerId: string; networkId?: number; username?: string };
  playerLeft: { playerId: string; networkId?: number };
  syncState: { state: any };
  sendEvent: { event: string; data: any };
  gameEvent: { senderNetworkId: number; event: string; data: any };
}

// Scene transition events
export interface SceneEvents {
  startTransition: { to?: string };
  transitionComplete: {};
}
