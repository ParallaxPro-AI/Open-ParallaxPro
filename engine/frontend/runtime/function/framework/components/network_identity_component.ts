import { Component } from '../component.js';

/**
 * NetworkIdentityComponent marks an entity for network synchronization.
 *
 * The server assigns networkId and ownerId. Entities owned by the local player
 * send state updates at syncInterval. User scripts define networked variables
 * via setNetworkedVar/getNetworkedVar.
 */
export class NetworkIdentityComponent extends Component {
    networkId: number = -1;
    ownerId: number = -1;
    isLocalPlayer: boolean = false;
    syncTransform: boolean = true;
    syncInterval: number = 50;
    lastSyncTime: number = 0;

    private networkedVars: Map<string, { value: any; dirty: boolean }> = new Map();

    // -- Networked Variables API -----------------------------------------------

    setNetworkedVar(name: string, value: any): void {
        const entry = this.networkedVars.get(name);
        if (entry) {
            entry.value = value;
            entry.dirty = true;
        } else {
            this.networkedVars.set(name, { value, dirty: true });
        }
    }

    getNetworkedVar(name: string): any {
        const entry = this.networkedVars.get(name);
        return entry ? entry.value : undefined;
    }

    /**
     * Consume all dirty variables and clear their dirty flags.
     * Used by the NetworkSystem when sending state updates.
     */
    consumeDirtyVars(): Record<string, any> {
        const dirty: Record<string, any> = {};
        for (const [name, entry] of this.networkedVars) {
            if (entry.dirty) {
                dirty[name] = entry.value;
                entry.dirty = false;
            }
        }
        return dirty;
    }

    /**
     * Apply received variable values from the server (does not mark dirty).
     */
    applyReceivedVars(vars: Record<string, any>): void {
        for (const [name, value] of Object.entries(vars)) {
            const entry = this.networkedVars.get(name);
            if (entry) {
                entry.value = value;
                entry.dirty = false;
            } else {
                this.networkedVars.set(name, { value, dirty: false });
            }
        }
    }

    shouldSync(): boolean {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        return (now - this.lastSyncTime) >= this.syncInterval;
    }

    // -- Lifecycle ------------------------------------------------------------

    initialize(data: Record<string, any>): void {
        this.networkId = data.networkId ?? -1;
        this.ownerId = data.ownerId ?? -1;
        this.isLocalPlayer = data.isLocalPlayer ?? false;
        this.syncTransform = data.syncTransform ?? true;
        this.syncInterval = data.syncInterval ?? 50;

        if (data.networkedVars && typeof data.networkedVars === 'object') {
            for (const [name, value] of Object.entries(data.networkedVars)) {
                this.networkedVars.set(name, { value, dirty: false });
            }
        }
    }

    onDestroy(): void {
        this.networkedVars.clear();
    }

    toJSON(): Record<string, any> {
        const vars: Record<string, any> = {};
        for (const [name, entry] of this.networkedVars) {
            vars[name] = entry.value;
        }

        return {
            networkId: this.networkId,
            ownerId: this.ownerId,
            isLocalPlayer: this.isLocalPlayer,
            syncTransform: this.syncTransform,
            syncInterval: this.syncInterval,
            networkedVars: vars,
        };
    }
}
