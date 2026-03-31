import { InputDevice } from '../../platform/input/input_device.js';

export { InputSystem, type InputModifiers, type InputPlatformAdapter } from '../../../../shared/input/input_system.js';
import { InputSystem } from '../../../../shared/input/input_system.js';

/**
 * Connect a shared InputSystem to a DOM-based InputDevice.
 * Wires up event callbacks and sets the platform adapter for pointer lock and gamepads.
 */
export function connectInputDevice(inputSystem: InputSystem, inputDevice: InputDevice): void {
    inputDevice.onKeyDown((_key, code, repeat, mods) => {
        inputSystem.injectModifiers(mods);
        if (!repeat) {
            inputSystem.injectKeyDown(code);
        }
    });

    inputDevice.onKeyUp((_key, code, mods) => {
        inputSystem.injectModifiers(mods);
        inputSystem.injectKeyUp(code);
    });

    inputDevice.onMouseDown((button, x, y, mods) => {
        inputSystem.injectModifiers(mods);
        inputSystem.injectMouseButtonDown(button, x, y);
    });

    inputDevice.onMouseUp((button, x, y, mods) => {
        inputSystem.injectModifiers(mods);
        inputSystem.injectMouseButtonUp(button, x, y);
    });

    inputDevice.onMouseMove((x, y, deltaX, deltaY) => {
        inputSystem.injectMouseMove(x, y, deltaX, deltaY);
    });

    inputDevice.onWheel((deltaX, deltaY) => {
        inputSystem.injectWheel(deltaX, deltaY);
    });

    // Touch-to-mouse simulation for touch devices
    let primaryTouchId: number | null = null;
    let lastTouchX = 0;
    let lastTouchY = 0;

    inputDevice.onTouchStart((touches) => {
        if (primaryTouchId !== null) return;
        const t = touches[0];
        if (!t) return;

        primaryTouchId = t.identifier;
        const canvas = (inputDevice as any).canvas as HTMLCanvasElement | undefined;
        const rect = canvas?.getBoundingClientRect() ?? { left: 0, top: 0 };
        const x = t.clientX - rect.left;
        const y = t.clientY - rect.top;
        lastTouchX = x;
        lastTouchY = y;
        inputSystem.injectMouseMove(x, y, 0, 0);
        inputSystem.injectMouseButtonDown(0, x, y);
    });

    inputDevice.onTouchMove((touches) => {
        if (primaryTouchId === null) return;
        const t = touches.find(tt => tt.identifier === primaryTouchId);
        if (!t) return;
        const canvas = (inputDevice as any).canvas as HTMLCanvasElement | undefined;
        const rect = canvas?.getBoundingClientRect() ?? { left: 0, top: 0 };
        const x = t.clientX - rect.left;
        const y = t.clientY - rect.top;
        const dx = x - lastTouchX;
        const dy = y - lastTouchY;
        lastTouchX = x;
        lastTouchY = y;
        inputSystem.injectMouseMove(x, y, dx, dy);
    });

    inputDevice.onTouchEnd((touches) => {
        if (primaryTouchId === null) return;
        const still = touches.find(tt => tt.identifier === primaryTouchId);
        if (!still) {
            inputSystem.injectMouseButtonUp(0, lastTouchX, lastTouchY);
            primaryTouchId = null;
        }
    });

    inputSystem.setPlatformAdapter({
        requestPointerLock: () => inputDevice.requestPointerLock(),
        exitPointerLock: () => inputDevice.exitPointerLock(),
        isPointerLocked: () => inputDevice.isPointerLocked(),
        pollGamepads: () => {
            const gamepads = navigator.getGamepads();
            for (const gp of gamepads) {
                if (gp) return gp;
            }
            return null;
        },
    });
}
