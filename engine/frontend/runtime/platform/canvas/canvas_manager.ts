export class CanvasManager {
    private canvas: HTMLCanvasElement | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private resizeCallbacks: Array<(w: number, h: number) => void> = [];
    private pixelRatio: number = 1;

    initialize(canvasElement: HTMLCanvasElement): void {
        this.canvas = canvasElement;
        this.pixelRatio = window.devicePixelRatio || 1;

        this.updateCanvasSize();

        this.resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                if (entry.target === this.canvas) {
                    this.updateCanvasSize();
                    const w = this.getWidth();
                    const h = this.getHeight();
                    for (const cb of this.resizeCallbacks) {
                        cb(w, h);
                    }
                }
            }
        });
        this.resizeObserver.observe(canvasElement);
    }

    private updateCanvasSize(): void {
        if (!this.canvas) return;
        this.pixelRatio = window.devicePixelRatio || 1;
        const rect = this.canvas.getBoundingClientRect();
        this.canvas.width = Math.floor(rect.width * this.pixelRatio);
        this.canvas.height = Math.floor(rect.height * this.pixelRatio);
    }

    getCanvas(): HTMLCanvasElement {
        if (!this.canvas) {
            throw new Error('CanvasManager has not been initialized.');
        }
        return this.canvas;
    }

    getWidth(): number {
        if (!this.canvas) return 0;
        return this.canvas.width;
    }

    getHeight(): number {
        if (!this.canvas) return 0;
        return this.canvas.height;
    }

    getAspectRatio(): number {
        const h = this.getHeight();
        if (h === 0) return 1;
        return this.getWidth() / h;
    }

    getPixelRatio(): number {
        return this.pixelRatio;
    }

    onResize(callback: (w: number, h: number) => void): void {
        this.resizeCallbacks.push(callback);
    }

    offResize(callback: (w: number, h: number) => void): void {
        const index = this.resizeCallbacks.indexOf(callback);
        if (index !== -1) {
            this.resizeCallbacks.splice(index, 1);
        }
    }

    destroy(): void {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        this.resizeCallbacks.length = 0;
        this.canvas = null;
    }
}
