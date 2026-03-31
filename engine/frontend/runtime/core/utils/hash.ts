/**
 * Compute a 32-bit hash of a string using the djb2 algorithm.
 * Returns a non-negative integer.
 */
export function hashString(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return hash >>> 0;
}

/**
 * Combine two hash values into a single hash using a boost-style combiner.
 */
export function hashCombine(a: number, b: number): number {
    a = (a ^ (b + 0x9e3779b9 + (a << 6) + (a >>> 2))) | 0;
    return a >>> 0;
}
