import {
    GL2Buffer, GL2Texture,
    makeGL2Buffer, makeGL2Texture,
} from './gl2_handles.js';

/**
 * Centralized WebGL2 buffer / texture creation. Mirrors the surface of
 * GPUResourceManager but produces wrapped handles (see gl2_handles.ts).
 * No bind-group machinery — WebGL2's binding model is direct
 * (gl.bindBuffer / gl.uniform*), driven by each pass.
 */
export class GL2ResourceManager {
    private gl: WebGL2RenderingContext | null = null;
    private nextId = 0;

    initialize(gl: WebGL2RenderingContext): void {
        this.gl = gl;
    }

    getContext(): WebGL2RenderingContext {
        if (!this.gl) throw new Error('GL2ResourceManager not initialized');
        return this.gl;
    }

    createVertexBuffer(data: Float32Array | Uint16Array | Uint32Array, label?: string): GL2Buffer {
        const gl = this.getContext();
        const buf = makeGL2Buffer(gl, gl.ARRAY_BUFFER, data.byteLength, label ?? `vertex_${this.nextId++}`);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf.glBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        return buf;
    }

    createIndexBuffer(data: Uint16Array | Uint32Array, label?: string): GL2Buffer {
        const gl = this.getContext();
        const buf = makeGL2Buffer(gl, gl.ELEMENT_ARRAY_BUFFER, data.byteLength, label ?? `index_${this.nextId++}`);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf.glBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
        return buf;
    }

    createUniformBuffer(byteLength: number, label?: string): GL2Buffer {
        const gl = this.getContext();
        const buf = makeGL2Buffer(gl, gl.UNIFORM_BUFFER, byteLength, label ?? `ubo_${this.nextId++}`);
        gl.bindBuffer(gl.UNIFORM_BUFFER, buf.glBuffer);
        gl.bufferData(gl.UNIFORM_BUFFER, byteLength, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.UNIFORM_BUFFER, null);
        return buf;
    }

    /** Used for joint matrices that the WebGPU path keeps in a storage
     *  buffer; on WebGL2 we map to a UBO (≤64 mat4 = 4096 bytes, well
     *  under the spec-mandated 16 KB UBO floor). For meshes with more
     *  joints, the UBO is sized to whatever the platform supports —
     *  callers don't currently produce skeletons that big. */
    createJointBuffer(jointCount: number, label?: string): GL2Buffer {
        const gl = this.getContext();
        const size = Math.max(64, jointCount * 64);
        const buf = makeGL2Buffer(gl, gl.UNIFORM_BUFFER, size, label ?? `joints_${this.nextId++}`);
        gl.bindBuffer(gl.UNIFORM_BUFFER, buf.glBuffer);
        gl.bufferData(gl.UNIFORM_BUFFER, size, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.UNIFORM_BUFFER, null);
        return buf;
    }

    writeBuffer(buf: GL2Buffer, offset: number, data: ArrayBufferView): void {
        const gl = this.getContext();
        gl.bindBuffer(buf.target, buf.glBuffer);
        gl.bufferSubData(buf.target, offset, data);
        gl.bindBuffer(buf.target, null);
    }

    uploadTexture2DFromBitmap(bitmap: ImageBitmap, params?: { generateMipmaps?: boolean; label?: string; sRGB?: boolean }): GL2Texture {
        const gl = this.getContext();
        const tex = makeGL2Texture(gl, gl.TEXTURE_2D, bitmap.width, bitmap.height, params?.label ?? `tex_${this.nextId++}`);
        gl.bindTexture(gl.TEXTURE_2D, tex.glTexture);

        const internalFormat = params?.sRGB ? gl.SRGB8_ALPHA8 : gl.RGBA8;
        gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, bitmap.width, bitmap.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);

        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        if (params?.generateMipmaps !== false) {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
            gl.generateMipmap(gl.TEXTURE_2D);
        } else {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        }

        gl.bindTexture(gl.TEXTURE_2D, null);
        return tex;
    }

    /** 1×1 white fallback texture so meshes without an albedo map still
     *  render with their material baseColor visible. */
    createDefaultWhiteTexture(): GL2Texture {
        const gl = this.getContext();
        const tex = makeGL2Texture(gl, gl.TEXTURE_2D, 1, 1, 'default_white');
        gl.bindTexture(gl.TEXTURE_2D, tex.glTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);
        return tex;
    }

    uploadTexture2DArray(bitmaps: (ImageBitmap | null)[], params?: { generateMipmaps?: boolean; label?: string }): GL2Texture {
        const gl = this.getContext();
        const layerCount = bitmaps.length;
        const first = bitmaps.find(b => b !== null);
        if (!first) throw new Error('uploadTexture2DArray: all bitmaps are null');
        const w = first.width, h = first.height;
        const mipLevels = params?.generateMipmaps !== false ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;

        const tex = makeGL2Texture(gl, gl.TEXTURE_2D_ARRAY, w, h, params?.label ?? `tex_array_${this.nextId++}`);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex.glTexture);
        gl.texStorage3D(gl.TEXTURE_2D_ARRAY, mipLevels, gl.RGBA8, w, h, layerCount);

        for (let i = 0; i < layerCount; i++) {
            if (bitmaps[i]) {
                gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, w, h, 1, gl.RGBA, gl.UNSIGNED_BYTE, bitmaps[i]!);
            }
        }

        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        if (mipLevels > 1) {
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
            gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
        } else {
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        }
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
        return tex;
    }

    uploadTexture2DFromRawRGBA(data: Uint8Array, width: number, height: number, params?: { label?: string }): GL2Texture {
        const gl = this.getContext();
        const tex = makeGL2Texture(gl, gl.TEXTURE_2D, width, height, params?.label ?? `tex_raw_${this.nextId++}`);
        gl.bindTexture(gl.TEXTURE_2D, tex.glTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.bindTexture(gl.TEXTURE_2D, null);
        return tex;
    }

    shutdown(): void {
        this.gl = null;
    }
}
