export const MessageType = {
    CONNECT: 'connect',
    DISCONNECT: 'disconnect',
    HANDSHAKE: 'handshake',
    HANDSHAKE_ACK: 'handshake_ack',

    ENTITY_SPAWN: 'entity_spawn',
    ENTITY_DESPAWN: 'entity_despawn',
    ENTITY_STATE: 'entity_state',
    ENTITY_STATE_BATCH: 'entity_state_batch',

    PLAYER_JOIN: 'player_join',
    PLAYER_LEAVE: 'player_leave',
    PLAYER_INPUT: 'player_input',

    GAME_STATE_FULL: 'game_state_full',
    GAME_STATE_DELTA: 'game_state_delta',

    RPC_CALL: 'rpc_call',
    RPC_RESPONSE: 'rpc_response',

    PING: 'ping',
    PONG: 'pong',
} as const;

export type MessageTypeValue = typeof MessageType[keyof typeof MessageType];

export interface EntityStateMessage {
    entityId: number;
    position: [number, number, number];
    rotation: [number, number, number, number];
    velocity?: [number, number, number];
    timestamp: number;
}

export interface EntitySpawnMessage {
    entityId: number;
    prefabName: string;
    position: [number, number, number];
    rotation: [number, number, number, number];
    ownerId?: number;
}

export interface EntityDespawnMessage {
    entityId: number;
}

export interface PlayerInputMessage {
    sequenceNumber: number;
    inputs: Record<string, number | boolean>;
    timestamp: number;
}
