export type WrapMode = 'repeat' | 'clamp' | 'mirror';
export type FilterMode = 'nearest' | 'linear';

export class TextureData {
    uuid: string = '';
    width: number = 0;
    height: number = 0;
    format: string = 'rgba8unorm';
    wrapU: WrapMode = 'repeat';
    wrapV: WrapMode = 'repeat';
    filterMin: FilterMode = 'linear';
    filterMag: FilterMode = 'linear';
    generateMipmaps: boolean = true;

    toJSON(): any {
        return {
            uuid: this.uuid,
            width: this.width,
            height: this.height,
            format: this.format,
            wrapU: this.wrapU,
            wrapV: this.wrapV,
            filterMin: this.filterMin,
            filterMag: this.filterMag,
            generateMipmaps: this.generateMipmaps,
        };
    }

    static fromJSON(data: any): TextureData {
        const tex = new TextureData();
        if (!data) return tex;
        tex.uuid = data.uuid ?? '';
        tex.width = data.width ?? 0;
        tex.height = data.height ?? 0;
        tex.format = data.format ?? 'rgba8unorm';
        tex.wrapU = data.wrapU ?? 'repeat';
        tex.wrapV = data.wrapV ?? 'repeat';
        tex.filterMin = data.filterMin ?? 'linear';
        tex.filterMag = data.filterMag ?? 'linear';
        tex.generateMipmaps = data.generateMipmaps ?? true;
        return tex;
    }
}
