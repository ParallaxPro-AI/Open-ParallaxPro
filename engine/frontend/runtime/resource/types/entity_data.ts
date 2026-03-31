import { ComponentData } from './component_data';

export class EntityData {
    id: number = 0;
    name: string = '';
    parentId: number | null = null;
    tags: string[] = [];
    active: boolean = true;
    components: ComponentData[] = [];

    toJSON(): any {
        return {
            id: this.id,
            name: this.name,
            parentId: this.parentId,
            tags: [...this.tags],
            active: this.active,
            components: this.components.map((c) => c.toJSON()),
        };
    }

    static fromJSON(data: any): EntityData {
        const entity = new EntityData();
        if (!data) return entity;
        entity.id = data.id ?? 0;
        entity.name = data.name ?? '';
        entity.parentId = data.parentId ?? null;
        entity.tags = Array.isArray(data.tags) ? [...data.tags] : [];
        entity.active = data.active ?? true;
        entity.components = Array.isArray(data.components)
            ? data.components.map((c: any) => ComponentData.fromJSON(c))
            : [];
        return entity;
    }
}
