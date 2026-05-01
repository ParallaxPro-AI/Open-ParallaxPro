/**
 * WebGL2 device wrapper. Sibling of GPUDeviceManager — owns the WebGL2
 * rendering context, capability flags, and basic GL state. Used only
 * when the boot probe selects the 'webgl2' fallback backend (older
 * iOS Safari, Firefox without WebGPU flag, etc.).
 *
 * V1 capabilities we rely on (all standard in WebGL2):
 *  - Vertex array objects (VAOs)
 *  - Uniform buffer objects (UBOs)
 *  - sRGB framebuffer + texture sampling
 *  - GLSL ES 3.00 shaders
 *  - Instanced drawing
 */
export class GL2DeviceManager {
    private canvas: HTMLCanvasElement | null = null;
    private gl: WebGL2RenderingContext | null = null;

    initialize(canvas: HTMLCanvasElement): void {
        this.canvas = canvas;
        const gl = canvas.getContext('webgl2', {
            alpha: false,
            antialias: true,
            depth: true,
            stencil: false,
            premultipliedAlpha: true,
            preserveDrawingBuffer: false,
            powerPreference: 'high-performance',
        });
        if (!gl) {
            throw new Error('Failed to obtain a WebGL2 rendering context.');
        }
        this.gl = gl;

        // Sane defaults. Pipelines/passes flip these as needed each frame.
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);
        gl.frontFace(gl.CCW);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

        // Surface lost-context as a console error so users get a hint
        // instead of silently freezing. WebGL2 contexts can be reclaimed
        // by the browser under memory pressure (most common on mobile).
        canvas.addEventListener('webglcontextlost', (e) => {
            e.preventDefault();
            console.error('[gl2] WebGL2 context lost — page reload required.');
        });
    }

    getContext(): WebGL2RenderingContext {
        if (!this.gl) {
            throw new Error('GL2DeviceManager has not been initialized.');
        }
        return this.gl;
    }

    getCanvas(): HTMLCanvasElement {
        if (!this.canvas) {
            throw new Error('GL2DeviceManager has not been initialized.');
        }
        return this.canvas;
    }

    /** True if the WebGL2 context is alive (i.e. not lost / not destroyed). */
    isAlive(): boolean {
        return this.gl !== null && !this.gl.isContextLost();
    }

    destroy(): void {
        // WebGL2 has no explicit "destroy context" API. Closing the
        // canvas / dropping references is enough; the browser GCs
        // textures/buffers when the context becomes unreachable. We
        // null the local refs so attempts to use a destroyed device
        // throw rather than silently render into a dead context.
        this.gl = null;
        this.canvas = null;
    }
}
