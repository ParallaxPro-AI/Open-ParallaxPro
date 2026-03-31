export class ComponentData {
    type: string = '';
    data: Record<string, any> = {};

    toJSON(): any {
        return {
            type: this.type,
            data: JSON.parse(JSON.stringify(this.data)),
        };
    }

    static fromJSON(data: any): ComponentData {
        const comp = new ComponentData();
        if (!data) return comp;
        comp.type = data.type ?? '';
        comp.data = data.data ? JSON.parse(JSON.stringify(data.data)) : {};
        return comp;
    }
}
