import { GameScript } from './script_api.js';
import { Vec3 } from '../../core/math/vec3.js';
import { Quat } from '../../core/math/quat.js';

/**
 * Parse a JavaScript script source and return a class constructor.
 *
 * The source should define a class that extends GameScript (or a plain class
 * with the same lifecycle methods). The returned constructor can be used with
 * ScriptSystem.registerScript().
 */
export function loadScriptClass(source: string): (new () => GameScript) | null {
    try {
        const classMatch = source.match(/class\s+(\w+)/);
        if (!classMatch) {
            console.warn('ScriptLoader: no class found in source');
            return null;
        }
        const className = classMatch[1];

        const fn = new Function(
            'GameScript', 'Vec3', 'Quat',
            `${source}\nreturn ${className};`
        );

        return fn(GameScript, Vec3, Quat);
    } catch (e) {
        console.error('ScriptLoader: failed to load script:', e);
        return null;
    }
}
