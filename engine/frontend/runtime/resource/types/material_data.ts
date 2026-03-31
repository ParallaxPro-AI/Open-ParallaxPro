export type AlphaMode = 'opaque' | 'mask' | 'blend';

export class MaterialData {
    baseColorFactor: [number, number, number, number] = [1, 1, 1, 1];
    baseColorTextureUUID: string | null = null;
    metallicFactor: number = 0.0;
    roughnessFactor: number = 0.5;
    metallicRoughnessTextureUUID: string | null = null;
    normalTextureUUID: string | null = null;
    normalScale: number = 1.0;
    occlusionTextureUUID: string | null = null;
    occlusionStrength: number = 1.0;
    emissiveFactor: [number, number, number] = [0, 0, 0];
    emissiveTextureUUID: string | null = null;
    alphaMode: AlphaMode = 'opaque';
    alphaCutoff: number = 0.5;
    doubleSided: boolean = false;

    toJSON(): any {
        return {
            baseColorFactor: [...this.baseColorFactor] as [number, number, number, number],
            baseColorTextureUUID: this.baseColorTextureUUID,
            metallicFactor: this.metallicFactor,
            roughnessFactor: this.roughnessFactor,
            metallicRoughnessTextureUUID: this.metallicRoughnessTextureUUID,
            normalTextureUUID: this.normalTextureUUID,
            normalScale: this.normalScale,
            occlusionTextureUUID: this.occlusionTextureUUID,
            occlusionStrength: this.occlusionStrength,
            emissiveFactor: [...this.emissiveFactor] as [number, number, number],
            emissiveTextureUUID: this.emissiveTextureUUID,
            alphaMode: this.alphaMode,
            alphaCutoff: this.alphaCutoff,
            doubleSided: this.doubleSided,
        };
    }

    static fromJSON(data: any): MaterialData {
        const mat = new MaterialData();
        if (!data) return mat;
        if (data.baseColorFactor) {
            mat.baseColorFactor = [
                data.baseColorFactor[0], data.baseColorFactor[1],
                data.baseColorFactor[2], data.baseColorFactor[3],
            ];
        }
        mat.baseColorTextureUUID = data.baseColorTextureUUID ?? null;
        mat.metallicFactor = data.metallicFactor ?? 0.0;
        mat.roughnessFactor = data.roughnessFactor ?? 0.5;
        mat.metallicRoughnessTextureUUID = data.metallicRoughnessTextureUUID ?? null;
        mat.normalTextureUUID = data.normalTextureUUID ?? null;
        mat.normalScale = data.normalScale ?? 1.0;
        mat.occlusionTextureUUID = data.occlusionTextureUUID ?? null;
        mat.occlusionStrength = data.occlusionStrength ?? 1.0;
        if (data.emissiveFactor) {
            mat.emissiveFactor = [data.emissiveFactor[0], data.emissiveFactor[1], data.emissiveFactor[2]];
        }
        mat.emissiveTextureUUID = data.emissiveTextureUUID ?? null;
        mat.alphaMode = data.alphaMode ?? 'opaque';
        mat.alphaCutoff = data.alphaCutoff ?? 0.5;
        mat.doubleSided = data.doubleSided ?? false;
        return mat;
    }
}
