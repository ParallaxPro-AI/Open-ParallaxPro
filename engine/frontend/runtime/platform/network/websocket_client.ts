export class WebSocketClient {
    private ws: WebSocket | null = null;
    private handlers: Map<string, Set<(data: any) => void>> = new Map();
    private connectCallbacks: Set<() => void> = new Set();
    private disconnectCallbacks: Set<() => void> = new Set();
    private connectionAttemptId: number = 0;

    connect(url: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if (this.ws) {
                this.ws.close();
                this.ws = null;
            }

            const attemptId = ++this.connectionAttemptId;
            let settled = false;
            const fail = (message: string) => {
                if (!settled) {
                    settled = true;
                    reject(new Error(message));
                }
            };
            const succeed = () => {
                if (!settled) {
                    settled = true;
                    resolve();
                }
            };

            const ws = new WebSocket(url);
            this.ws = ws;

            ws.onopen = () => {
                if (attemptId !== this.connectionAttemptId) return;
                for (const cb of this.connectCallbacks) {
                    cb();
                }
                succeed();
            };

            ws.onerror = () => {
                if (attemptId !== this.connectionAttemptId) return;
                fail('WebSocket connection error');
            };

            ws.onclose = () => {
                if (attemptId !== this.connectionAttemptId) return;
                for (const cb of this.disconnectCallbacks) {
                    cb();
                }
                this.ws = null;
                fail('WebSocket connection closed before opening');
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
        this.connectionAttemptId++;
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

    clearMessageHandlers(): void {
        this.handlers.clear();
    }

    clearLifecycleCallbacks(): void {
        this.connectCallbacks.clear();
        this.disconnectCallbacks.clear();
    }

    isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }
}
