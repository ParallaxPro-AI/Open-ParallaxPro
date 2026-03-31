export type WeatherType = 'clear' | 'rain' | 'snow' | 'fog' | 'storm';

export class EnvironmentData {
    skyboxAssetUUID: string | null = null;
    ambientLight: { color: [number, number, number]; intensity: number } = { color: [1, 1, 1], intensity: 0.3 };
    fog: { enabled: boolean; color: [number, number, number]; near: number; far: number } = {
        enabled: false, color: [0.8, 0.8, 0.8], near: 10, far: 100,
    };
    gravity: [number, number, number] = [0, -9.81, 0];

    /** Time of day in hours (0-24). 0/24 = midnight, 6 = dawn, 12 = noon, 18 = dusk. */
    timeOfDay: number = 12.0;
    /** Day/night cycle speed multiplier. 0 = static, 1 = real-time, 60 = 1 minute per game second. */
    dayNightCycleSpeed: number = 0;

    weather: {
        type: WeatherType;
        intensity: number;
        windDirection: [number, number, number];
        windSpeed: number;
    } = { type: 'clear', intensity: 0, windDirection: [1, 0, 0], windSpeed: 0 };

    toJSON(): any {
        return {
            skyboxAssetUUID: this.skyboxAssetUUID,
            ambientLight: {
                color: [...this.ambientLight.color] as [number, number, number],
                intensity: this.ambientLight.intensity,
            },
            fog: {
                enabled: this.fog.enabled,
                color: [...this.fog.color] as [number, number, number],
                near: this.fog.near,
                far: this.fog.far,
            },
            gravity: [...this.gravity] as [number, number, number],
            timeOfDay: this.timeOfDay,
            dayNightCycleSpeed: this.dayNightCycleSpeed,
            weather: {
                type: this.weather.type,
                intensity: this.weather.intensity,
                windDirection: [...this.weather.windDirection] as [number, number, number],
                windSpeed: this.weather.windSpeed,
            },
        };
    }

    static fromJSON(data: any): EnvironmentData {
        const env = new EnvironmentData();
        if (!data) return env;
        env.skyboxAssetUUID = data.skyboxAssetUUID ?? null;
        if (data.ambientLight) {
            env.ambientLight = {
                color: data.ambientLight.color
                    ? [data.ambientLight.color[0], data.ambientLight.color[1], data.ambientLight.color[2]]
                    : [1, 1, 1],
                intensity: data.ambientLight.intensity ?? 0.3,
            };
        }
        if (data.fog) {
            env.fog = {
                enabled: data.fog.enabled ?? false,
                color: data.fog.color
                    ? [data.fog.color[0], data.fog.color[1], data.fog.color[2]]
                    : [0.8, 0.8, 0.8],
                near: data.fog.near ?? 10,
                far: data.fog.far ?? 100,
            };
        }
        if (data.gravity) {
            env.gravity = [data.gravity[0], data.gravity[1], data.gravity[2]];
        }
        env.timeOfDay = data.timeOfDay ?? 12.0;
        env.dayNightCycleSpeed = data.dayNightCycleSpeed ?? 0;
        if (data.weather) {
            env.weather = {
                type: data.weather.type ?? 'clear',
                intensity: data.weather.intensity ?? 0,
                windDirection: data.weather.windDirection
                    ? [data.weather.windDirection[0], data.weather.windDirection[1], data.weather.windDirection[2]]
                    : [1, 0, 0],
                windSpeed: data.weather.windSpeed ?? 0,
            };
        }
        return env;
    }
}
