import { Color } from '../../../core/math/color.js';
import { Component } from '../component.js';

export enum LightType {
    DIRECTIONAL = 0,
    POINT = 1,
    SPOT = 2,
}

/**
 * LightComponent defines a light source on an entity.
 *
 * Light direction/position comes from the entity's TransformComponent.
 * The RenderSystem queries entities with LightComponent to build the light list.
 */
export class LightComponent extends Component {
    lightType: LightType = LightType.DIRECTIONAL;
    color: Color;
    intensity: number = 1.0;
    range: number = 10;
    innerConeAngle: number = 0.3;
    outerConeAngle: number = 0.5;
    castShadows: boolean = false;
    shadowMapSize: number = 1024;

    constructor() {
        super();
        this.color = new Color(1, 1, 1, 1);
    }

    initialize(data: Record<string, any>): void {
        const lt = data.lightType ?? LightType.DIRECTIONAL;
        if (typeof lt === 'string') {
            const map: Record<string, LightType> = {
                directional: LightType.DIRECTIONAL,
                point: LightType.POINT,
                spot: LightType.SPOT,
            };
            this.lightType = map[lt.toLowerCase()] ?? LightType.DIRECTIONAL;
        } else {
            this.lightType = lt;
        }

        if (data.color) {
            if (Array.isArray(data.color)) {
                this.color = new Color(data.color[0] ?? 1, data.color[1] ?? 1, data.color[2] ?? 1, data.color[3] ?? 1);
            } else {
                this.color = Color.fromJSON(data.color);
            }
        }

        const defaultIntensity = this.lightType === LightType.DIRECTIONAL ? 5.0 : 10.0;
        this.intensity = data.intensity ?? defaultIntensity;
        this.range = data.range ?? 10;
        this.innerConeAngle = data.innerConeAngle ?? 0.3;
        this.outerConeAngle = data.outerConeAngle ?? 0.5;
        this.castShadows = data.castShadows ?? false;
        this.shadowMapSize = data.shadowMapSize ?? 1024;
    }

    toJSON(): Record<string, any> {
        return {
            lightType: this.lightType,
            color: this.color.toJSON(),
            intensity: this.intensity,
            range: this.range,
            innerConeAngle: this.innerConeAngle,
            outerConeAngle: this.outerConeAngle,
            castShadows: this.castShadows,
            shadowMapSize: this.shadowMapSize,
        };
    }
}
