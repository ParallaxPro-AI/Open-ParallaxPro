export interface AssetManifest {
    [localName: string]: string;
}

export interface ProjectSettings {
    physics?: { gravity?: [number, number, number]; fixedTimestep?: number };
    rendering?: { shadowMapSize?: number; antiAliasing?: boolean; graphicsQuality?: 'low' | 'medium' | 'high' };
    network?: { tickRate?: number; interpolationDelay?: number };
}

export class ProjectConfig {
    name: string = '';
    version: string = '1.0.0';
    defaultSceneURL: string = 'scenes/main.scene.json';
    assetManifest: AssetManifest = {};
    settings: ProjectSettings = {};

    toJSON(): any {
        return {
            name: this.name,
            version: this.version,
            defaultSceneURL: this.defaultSceneURL,
            assetManifest: { ...this.assetManifest },
            settings: JSON.parse(JSON.stringify(this.settings)),
        };
    }

    static fromJSON(data: any): ProjectConfig {
        const config = new ProjectConfig();
        if (!data) return config;
        config.name = data.name ?? '';
        config.version = data.version ?? '1.0.0';
        config.defaultSceneURL = data.defaultSceneURL ?? 'scenes/main.scene.json';
        config.assetManifest = data.assetManifest ? { ...data.assetManifest } : {};
        config.settings = data.settings ? JSON.parse(JSON.stringify(data.settings)) : {};
        return config;
    }
}
