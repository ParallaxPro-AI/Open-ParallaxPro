import { Component } from '../component.js';

/**
 * ScriptComponent attaches user-authored game logic to an entity.
 *
 * Scripts are JavaScript classes implementing lifecycle methods (start, update,
 * lateUpdate, onDestroy). The ScriptComponent loads the script source,
 * instantiates the class, and delegates lifecycle calls.
 *
 * Either scriptAssetUUID (reusable script) or scriptURL (project-local script)
 * should be set, not both. scriptURL takes precedence.
 */
export class ScriptComponent extends Component {
    scriptAssetUUID: string = '';
    scriptURL: string = '';
    properties: Record<string, any> = {};

    /**
     * Additional script entries for entities with multiple scripts.
     * Each entry has { scriptURL, properties }.
     */
    additionalScripts: { scriptURL: string; properties: Record<string, any> }[] = [];

    // -- Runtime State --------------------------------------------------------

    scriptInstance: any = null;
    additionalInstances: any[] = [];
    private scriptStarted: boolean = false;

    // -- Lifecycle ------------------------------------------------------------

    initialize(data: Record<string, any>): void {
        this.scriptAssetUUID = data.scriptAssetUUID ?? '';
        this.scriptURL = data.scriptURL ?? '';
        this.properties = data.properties
            ? JSON.parse(JSON.stringify(data.properties))
            : {};
        this.additionalScripts = Array.isArray(data.additionalScripts)
            ? data.additionalScripts.map((s: any) => ({
                scriptURL: s.scriptURL ?? '',
                properties: s.properties ? JSON.parse(JSON.stringify(s.properties)) : {},
            }))
            : [];
        this.additionalInstances = [];
    }

    /**
     * Merge another ScriptComponent's data as an additional script.
     * Called when the scene has multiple ScriptComponent entries on one entity.
     */
    mergeScript(data: Record<string, any>): void {
        const url = data.scriptURL ?? data.scriptAssetUUID ?? '';
        if (url) {
            this.additionalScripts.push({
                scriptURL: url,
                properties: data.properties
                    ? JSON.parse(JSON.stringify(data.properties))
                    : {},
            });
        }
    }

    start(): void {
        if (!this.scriptStarted) {
            this.scriptStarted = true;
            this.startInstance(this.scriptInstance, this.properties);
            for (let i = 0; i < this.additionalInstances.length; i++) {
                const props = this.additionalScripts[i]?.properties ?? {};
                this.startInstance(this.additionalInstances[i], props);
            }
        }
    }

    tick(deltaTime: number): void {
        if (!this.scriptStarted && (this.scriptInstance || this.additionalInstances.length > 0)) {
            this.start();
        }

        if (this.scriptInstance && typeof this.scriptInstance.update === 'function') {
            this.scriptInstance.update(deltaTime);
        }
        for (const inst of this.additionalInstances) {
            if (inst && typeof inst.update === 'function') {
                inst.update(deltaTime);
            }
        }
    }

    lateUpdate(deltaTime: number): void {
        if (this.scriptInstance && typeof this.scriptInstance.lateUpdate === 'function') {
            this.scriptInstance.lateUpdate(deltaTime);
        }
        for (const inst of this.additionalInstances) {
            if (inst && typeof inst.lateUpdate === 'function') {
                inst.lateUpdate(deltaTime);
            }
        }
    }

    onDestroy(): void {
        if (this.scriptInstance && typeof this.scriptInstance.onDestroy === 'function') {
            this.scriptInstance.onDestroy();
        }
        for (const inst of this.additionalInstances) {
            if (inst && typeof inst.onDestroy === 'function') {
                inst.onDestroy();
            }
        }
        this.scriptInstance = null;
        this.additionalInstances = [];
        this.scriptStarted = false;
    }

    // -- Script Instance Management -------------------------------------------

    setScriptInstance(instance: any): void {
        this.scriptInstance = instance;
        this.scriptStarted = false;
        if (instance && instance.entity === undefined) {
            instance.entity = this.entity;
        }
    }

    addScriptInstance(instance: any): void {
        if (instance && instance.entity === undefined) {
            instance.entity = this.entity;
        }
        this.additionalInstances.push(instance);
    }

    getScriptRef(): string {
        return this.scriptURL || this.scriptAssetUUID;
    }

    getAllScriptRefs(): string[] {
        const refs: string[] = [];
        const primary = this.getScriptRef();
        if (primary) refs.push(primary);
        for (const s of this.additionalScripts) {
            if (s.scriptURL) refs.push(s.scriptURL);
        }
        return refs;
    }

    toJSON(): Record<string, any> {
        const json: Record<string, any> = {
            scriptAssetUUID: this.scriptAssetUUID,
            scriptURL: this.scriptURL,
            properties: this.properties ? JSON.parse(JSON.stringify(this.properties)) : {},
        };
        if (this.additionalScripts.length > 0) {
            json.additionalScripts = this.additionalScripts.map(s => ({
                scriptURL: s.scriptURL,
                properties: s.properties ? JSON.parse(JSON.stringify(s.properties)) : {},
            }));
        }
        return json;
    }

    // -- Private --------------------------------------------------------------

    private startInstance(instance: any, properties: Record<string, any>): void {
        if (!instance) return;
        if (instance.entity === undefined) {
            instance.entity = this.entity;
        }
        for (const [key, value] of Object.entries(properties)) {
            instance[key] = value;
        }
        if (typeof instance.start === 'function') {
            instance.start();
        }
    }
}
