import { Component } from './component.js';

export type ComponentConstructor = new () => Component;

const registry = new Map<string, ComponentConstructor>();

export function registerComponent(typeName: string, ctor: ComponentConstructor): void {
    registry.set(typeName, ctor);
}

export function createComponent(typeName: string): Component | null {
    const ctor = registry.get(typeName);
    if (!ctor) return null;
    return new ctor();
}

export function getRegisteredComponentTypes(): string[] {
    return Array.from(registry.keys());
}
