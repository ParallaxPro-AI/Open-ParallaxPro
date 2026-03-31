import { EntityData } from './entity_data';
import { EnvironmentData } from './environment_data';

export class SceneData {
    name: string = '';
    entities: EntityData[] = [];
    environment: EnvironmentData = new EnvironmentData();

    toJSON(): any {
        return {
            name: this.name,
            entities: this.entities.map((e) => e.toJSON()),
            environment: this.environment.toJSON(),
        };
    }

    static fromJSON(data: any): SceneData {
        const scene = new SceneData();
        if (!data) return scene;
        scene.name = data.name ?? '';
        scene.entities = Array.isArray(data.entities)
            ? data.entities.map((e: any) => EntityData.fromJSON(e))
            : [];
        scene.environment = data.environment
            ? EnvironmentData.fromJSON(data.environment)
            : new EnvironmentData();
        return scene;
    }
}
