/** Multiply two 4x4 column-major matrices. */
export function mat4Mul(a: number[], b: number[]): number[] {
    const r = new Array(16).fill(0);
    for (let col = 0; col < 4; col++)
        for (let row = 0; row < 4; row++)
            r[col * 4 + row] =
                a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] +
                a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
    return r;
}

/** Create a perspective projection matrix. */
export function mat4Perspective(fov: number, aspect: number, near: number, far: number): number[] {
    const f = 1 / Math.tan(fov / 2);
    const nf = 1 / (near - far);
    return [
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) * nf, -1,
        0, 0, 2 * far * near * nf, 0,
    ];
}

/** Create a look-at view matrix. */
export function mat4LookAt(eye: number[], center: number[], up: number[]): number[] {
    let fx = center[0] - eye[0], fy = center[1] - eye[1], fz = center[2] - eye[2];
    let len = Math.sqrt(fx * fx + fy * fy + fz * fz);
    fx /= len; fy /= len; fz /= len;
    let sx = fy * up[2] - fz * up[1], sy = fz * up[0] - fx * up[2], sz = fx * up[1] - fy * up[0];
    len = Math.sqrt(sx * sx + sy * sy + sz * sz);
    sx /= len; sy /= len; sz /= len;
    const ux = sy * fz - sz * fy, uy = sz * fx - sx * fz, uz = sx * fy - sy * fx;
    return [
        sx, ux, -fx, 0,
        sy, uy, -fy, 0,
        sz, uz, -fz, 0,
        -(sx * eye[0] + sy * eye[1] + sz * eye[2]),
        -(ux * eye[0] + uy * eye[1] + uz * eye[2]),
        (fx * eye[0] + fy * eye[1] + fz * eye[2]),
        1,
    ];
}

/** Project a 3D position to 2D screen coordinates using a model-view-projection matrix. */
export function project(pos: number[], mvp: number[], w: number, h: number): [number, number, number] {
    const x = mvp[0] * pos[0] + mvp[4] * pos[1] + mvp[8] * pos[2] + mvp[12];
    const y = mvp[1] * pos[0] + mvp[5] * pos[1] + mvp[9] * pos[2] + mvp[13];
    const z = mvp[2] * pos[0] + mvp[6] * pos[1] + mvp[10] * pos[2] + mvp[14];
    const ww = mvp[3] * pos[0] + mvp[7] * pos[1] + mvp[11] * pos[2] + mvp[15];
    if (Math.abs(ww) < 1e-6) return [0, 0, -1];
    const ndcX = x / ww, ndcY = y / ww, ndcZ = z / ww;
    return [(ndcX * 0.5 + 0.5) * w, (1 - (ndcY * 0.5 + 0.5)) * h, ndcZ];
}

/** Multiply two quaternions. */
export function qMul(a: number[], b: number[]): number[] {
    const [ax, ay, az, aw] = a;
    const [bx, by, bz, bw] = b;
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ];
}

/** Rotate a vector by a quaternion. */
export function qRotVec(q: number[], v: [number, number, number] | number[]): number[] {
    const [qx, qy, qz] = q;
    const qw = q[3];
    const tx = 2 * (qy * v[2] - qz * v[1]);
    const ty = 2 * (qz * v[0] - qx * v[2]);
    const tz = 2 * (qx * v[1] - qy * v[0]);
    return [
        v[0] + qw * tx + (qy * tz - qz * ty),
        v[1] + qw * ty + (qz * tx - qx * tz),
        v[2] + qw * tz + (qx * ty - qy * tx),
    ];
}

/** Compute the inverse (conjugate) of a unit quaternion. */
export function qInverse(q: number[]): number[] {
    return [-q[0], -q[1], -q[2], q[3]];
}

/** Spherical linear interpolation between two quaternions. */
export function slerp(a: number[], b: number[], t: number): number[] {
    let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    const bFlip = dot < 0 ? [-b[0], -b[1], -b[2], -b[3]] : b;
    dot = Math.abs(dot);
    let s0: number, s1: number;
    if (dot > 0.9999) {
        s0 = 1 - t; s1 = t;
    } else {
        const omega = Math.acos(dot);
        const sinO = Math.sin(omega);
        s0 = Math.sin((1 - t) * omega) / sinO;
        s1 = Math.sin(t * omega) / sinO;
    }
    const r = [s0 * a[0] + s1 * bFlip[0], s0 * a[1] + s1 * bFlip[1], s0 * a[2] + s1 * bFlip[2], s0 * a[3] + s1 * bFlip[3]];
    const len = Math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2] + r[3] * r[3]);
    return len > 0 ? [r[0] / len, r[1] / len, r[2] / len, r[3] / len] : [0, 0, 0, 1];
}
