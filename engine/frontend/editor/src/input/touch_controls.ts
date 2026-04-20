import { EditorCamera } from './editor_camera.js';
import { EditorContext } from '../editor_context.js';

export class TouchControls {
    private container: HTMLElement;
    private camera: EditorCamera;

    private joystickEl: HTMLElement;
    private joystickThumb: HTMLElement;
    private joystickActive: boolean = false;
    private joystickTouchId: number = -1;
    private joystickCenterX: number = 0;
    private joystickCenterY: number = 0;
    private joystickRadius: number = 36;

    private verticalControls: HTMLElement;
    private upBtn: HTMLElement;
    private downBtn: HTMLElement;

    constructor(container: HTMLElement, camera: EditorCamera) {
        this.container = container;
        this.camera = camera;

        this.joystickEl = document.createElement('div');
        this.joystickEl.className = 'virtual-joystick';
        this.joystickEl.style.display = 'none';

        const base = document.createElement('div');
        base.className = 'joystick-base';
        this.joystickEl.appendChild(base);

        this.joystickThumb = document.createElement('div');
        this.joystickThumb.className = 'joystick-thumb';
        this.joystickEl.appendChild(this.joystickThumb);

        this.joystickEl.addEventListener('touchstart', this.onJoystickTouchStart, { passive: false });
        this.joystickEl.addEventListener('touchmove', this.onJoystickTouchMove, { passive: false });
        this.joystickEl.addEventListener('touchend', this.onJoystickTouchEnd, { passive: false });
        this.joystickEl.addEventListener('touchcancel', this.onJoystickTouchEnd, { passive: false });

        container.appendChild(this.joystickEl);

        this.verticalControls = document.createElement('div');
        this.verticalControls.className = 'fly-vertical-controls';
        this.verticalControls.style.display = 'none';

        this.upBtn = document.createElement('div');
        this.upBtn.className = 'fly-btn';
        this.upBtn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>';
        this.upBtn.addEventListener('touchstart', (e) => { e.preventDefault(); this.camera.touchMoveUp = true; this.upBtn.classList.add('active'); }, { passive: false });
        this.upBtn.addEventListener('touchend', () => { this.camera.touchMoveUp = false; this.upBtn.classList.remove('active'); });
        this.upBtn.addEventListener('touchcancel', () => { this.camera.touchMoveUp = false; this.upBtn.classList.remove('active'); });
        this.verticalControls.appendChild(this.upBtn);

        this.downBtn = document.createElement('div');
        this.downBtn.className = 'fly-btn';
        this.downBtn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
        this.downBtn.addEventListener('touchstart', (e) => { e.preventDefault(); this.camera.touchMoveDown = true; this.downBtn.classList.add('active'); }, { passive: false });
        this.downBtn.addEventListener('touchend', () => { this.camera.touchMoveDown = false; this.downBtn.classList.remove('active'); });
        this.downBtn.addEventListener('touchcancel', () => { this.camera.touchMoveDown = false; this.downBtn.classList.remove('active'); });
        this.verticalControls.appendChild(this.downBtn);

        container.appendChild(this.verticalControls);

        EditorContext.instance.on('cameraModeChanged', (mode: string) => {
            const show = mode === 'fly';
            this.joystickEl.style.display = show ? '' : 'none';
            this.verticalControls.style.display = show ? '' : 'none';
            if (!show) {
                this.resetJoystick();
            }
        });
    }

    private onJoystickTouchStart = (e: TouchEvent): void => {
        e.preventDefault();
        e.stopPropagation();
        if (this.joystickActive) return;
        const touch = e.changedTouches[0];
        this.joystickActive = true;
        this.joystickTouchId = touch.identifier;
        const rect = this.joystickEl.getBoundingClientRect();
        this.joystickCenterX = rect.left + rect.width / 2;
        this.joystickCenterY = rect.top + rect.height / 2;
        this.joystickRadius = rect.width / 2 - 24;
        this.updateJoystick(touch.clientX, touch.clientY);
        this.joystickThumb.classList.add('active');
    };

    private onJoystickTouchMove = (e: TouchEvent): void => {
        e.preventDefault();
        e.stopPropagation();
        if (!this.joystickActive) return;
        for (let i = 0; i < e.changedTouches.length; i++) {
            if (e.changedTouches[i].identifier === this.joystickTouchId) {
                this.updateJoystick(e.changedTouches[i].clientX, e.changedTouches[i].clientY);
                return;
            }
        }
    };

    private onJoystickTouchEnd = (e: TouchEvent): void => {
        for (let i = 0; i < e.changedTouches.length; i++) {
            if (e.changedTouches[i].identifier === this.joystickTouchId) {
                this.resetJoystick();
                return;
            }
        }
    };

    private updateJoystick(clientX: number, clientY: number): void {
        let dx = clientX - this.joystickCenterX;
        let dy = clientY - this.joystickCenterY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const maxR = this.joystickRadius;
        if (dist > maxR) {
            dx = (dx / dist) * maxR;
            dy = (dy / dist) * maxR;
        }
        this.joystickThumb.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
        this.camera.joystickX = dx / maxR;
        this.camera.joystickY = dy / maxR;
    }

    private resetJoystick(): void {
        this.joystickActive = false;
        this.joystickTouchId = -1;
        this.joystickThumb.style.transform = 'translate(-50%, -50%)';
        this.joystickThumb.classList.remove('active');
        this.camera.joystickX = 0;
        this.camera.joystickY = 0;
    }
}
