/**
 * WebGL2 handle wrappers. These quack as `GPUBuffer` / `GPUTexture` to
 * the rest of the engine — components store fields like
 * `animator.gpuJointMatricesBuffer: GPUBuffer | null` and
 * `RenderMeshInstance.baseColorTexture?: GPUTexture`, and we keep that
 * type signature unchanged so the WebGPU path stays byte-identical.
 *
 * The WebGL2 backend is the only thing that ever inspects these
 * wrappers; it casts them back to `GL2Buffer` / `GL2Texture` via
 * `asGL2Buffer()` / `asGL2Texture()` to read the real WebGL handle.
 * If a wrapper somehow leaks into a WebGPU code path, the cast at the
 * other end would fail loudly — that's intentional: backends never
 * mix in the same session.
 */

const GL2_BUFFER_BRAND = '__gl2_buffer';
const GL2_TEXTURE_BRAND = '__gl2_texture';

export interface GL2Buffer {
    [GL2_BUFFER_BRAND]: true;
    glBuffer: WebGLBuffer;
    byteLength: number;
    /** GL_ARRAY_BUFFER / GL_ELEMENT_ARRAY_BUFFER / GL_UNIFORM_BUFFER */
    target: number;
    label: string;
    /** No-op compat with `GPUBuffer.destroy()` */
    destroy: () => void;
}

export interface GL2Texture {
    [GL2_TEXTURE_BRAND]: true;
    glTexture: WebGLTexture;
    width: number;
    height: number;
    /** GL_TEXTURE_2D / GL_TEXTURE_2D_ARRAY / GL_TEXTURE_CUBE_MAP */
    target: number;
    label: string;
    destroy: () => void;
}

export function isGL2Buffer(x: any): x is GL2Buffer {
    return !!x && x[GL2_BUFFER_BRAND] === true;
}

export function isGL2Texture(x: any): x is GL2Texture {
    return !!x && x[GL2_TEXTURE_BRAND] === true;
}

export function asGL2Buffer(x: any): GL2Buffer {
    if (!isGL2Buffer(x)) {
        throw new Error('Expected a WebGL2 buffer wrapper, got an unbranded value (likely a real WebGPU GPUBuffer leaked into the GL2 path).');
    }
    return x;
}

export function asGL2Texture(x: any): GL2Texture {
    if (!isGL2Texture(x)) {
        throw new Error('Expected a WebGL2 texture wrapper, got an unbranded value (likely a real WebGPU GPUTexture leaked into the GL2 path).');
    }
    return x;
}

export function makeGL2Buffer(
    gl: WebGL2RenderingContext,
    target: number,
    byteLength: number,
    label: string,
): GL2Buffer {
    const glBuffer = gl.createBuffer();
    if (!glBuffer) throw new Error(`gl.createBuffer() returned null for ${label}`);
    return {
        [GL2_BUFFER_BRAND]: true,
        glBuffer,
        byteLength,
        target,
        label,
        destroy: () => { try { gl.deleteBuffer(glBuffer); } catch { /* swallow */ } },
    };
}

export function makeGL2Texture(
    gl: WebGL2RenderingContext,
    target: number,
    width: number,
    height: number,
    label: string,
): GL2Texture {
    const glTexture = gl.createTexture();
    if (!glTexture) throw new Error(`gl.createTexture() returned null for ${label}`);
    return {
        [GL2_TEXTURE_BRAND]: true,
        glTexture,
        width,
        height,
        target,
        label,
        destroy: () => { try { gl.deleteTexture(glTexture); } catch { /* swallow */ } },
    };
}
