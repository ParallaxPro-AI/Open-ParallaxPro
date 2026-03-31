export class GPUDeviceManager {
    private adapter: GPUAdapter | null = null;
    private device: GPUDevice | null = null;
    private context: GPUCanvasContext | null = null;
    private canvasFormat: GPUTextureFormat = 'bgra8unorm';

    async initialize(canvas: HTMLCanvasElement): Promise<void> {
        if (!navigator.gpu) {
            throw new Error('WebGPU is not supported in this browser.');
        }

        const adapter = await navigator.gpu.requestAdapter({
            powerPreference: 'high-performance',
        });
        if (!adapter) {
            throw new Error('Failed to obtain a WebGPU adapter.');
        }
        this.adapter = adapter;

        const device = await adapter.requestDevice();
        if (!device) {
            throw new Error('Failed to obtain a WebGPU device.');
        }
        this.device = device;

        device.lost.then((info) => {
            console.error(`WebGPU device was lost: ${info.message}`);
        });

        const context = canvas.getContext('webgpu');
        if (!context) {
            throw new Error('Failed to obtain a WebGPU canvas context.');
        }
        this.context = context;

        this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();

        context.configure({
            device: this.device,
            format: this.canvasFormat,
            alphaMode: 'premultiplied',
        });
    }

    getDevice(): GPUDevice {
        if (!this.device) {
            throw new Error('GPUDeviceManager has not been initialized.');
        }
        return this.device;
    }

    getContext(): GPUCanvasContext {
        if (!this.context) {
            throw new Error('GPUDeviceManager has not been initialized.');
        }
        return this.context;
    }

    getCanvasFormat(): GPUTextureFormat {
        return this.canvasFormat;
    }

    getAdapter(): GPUAdapter {
        if (!this.adapter) {
            throw new Error('GPUDeviceManager has not been initialized.');
        }
        return this.adapter;
    }

    destroy(): void {
        if (this.device) {
            this.device.destroy();
            this.device = null;
        }
        this.context = null;
        this.adapter = null;
    }
}
