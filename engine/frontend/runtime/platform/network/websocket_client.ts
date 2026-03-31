export class WebSocketClient {
    private ws: WebSocket | null = null;
    private handlers: Map<string, Set<(data: any) => void>> = new Map();
    private connectCallbacks: Set<() => void> = new Set();
    private disconnectCallbacks: Set<() => void> = new Set();

    connect(url: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if (this.ws) {
                this.ws.close();
                this.ws = null;
            }

            const ws = new WebSocket(url);
            this.ws = ws;

            ws.onopen = () => {
                for (const cb of this.connectCallbacks) {
                    cb();
                }
                resolve();
            };

            ws.onerror = () => {
                reject(new Error('WebSocket connection error'));
            };

            ws.onclose = () => {
                for (const cb of this.disconnectCallbacks) {
                    cb();
                }
                this.ws = null;
            };

            ws.onmessage = (event) => {
                try {
                    const parsed = JSON.parse(event.data);
                    const messageType = parsed.type as string;
                    const payload = parsed.payload;

                    if (messageType) {
                        const callbacks = this.handlers.get(messageType);
                        if (callbacks) {
                            for (const cb of callbacks) {
                                cb(payload);
                            }
                        }
                    }
                } catch {
                    // Non-JSON or malformed messages are ignored
                }
            };
        });
    }

    disconnect(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    send(messageType: string, payload: unknown): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket is not connected.');
        }
        this.ws.send(JSON.stringify({ type: messageType, payload }));
    }

    onMessage(messageType: string, callback: (data: any) => void): void {
        let set = this.handlers.get(messageType);
        if (!set) {
            set = new Set();
            this.handlers.set(messageType, set);
        }
        set.add(callback);
    }

    offMessage(messageType: string, callback: (data: any) => void): void {
        const set = this.handlers.get(messageType);
        if (set) {
            set.delete(callback);
            if (set.size === 0) {
                this.handlers.delete(messageType);
            }
        }
    }

    onConnect(callback: () => void): void {
        this.connectCallbacks.add(callback);
    }

    onDisconnect(callback: () => void): void {
        this.disconnectCallbacks.add(callback);
    }

    isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }
}
