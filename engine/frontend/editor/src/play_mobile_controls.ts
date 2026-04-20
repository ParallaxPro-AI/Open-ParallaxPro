const STORAGE_KEY = 'pp_mobile_controls_enabled';

export function initMobileControls(gameContainer: HTMLElement): void {
    const isMobile = ('ontouchstart' in window) && /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (!isMobile) return;

    let enabled = localStorage.getItem(STORAGE_KEY) !== 'false';

    const overlay = document.createElement('div');
    overlay.id = 'mobile-controls-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;pointer-events:none;';
    gameContainer.appendChild(overlay);

    // ── Left joystick (WASD) ──
    const joystick = document.createElement('div');
    joystick.style.cssText = 'position:absolute;bottom:24px;left:24px;width:130px;height:130px;pointer-events:auto;touch-action:none;';
    const jBase = document.createElement('div');
    jBase.style.cssText = 'position:absolute;inset:0;border-radius:50%;background:rgba(255,255,255,0.1);border:2px solid rgba(255,255,255,0.2);';
    const jThumb = document.createElement('div');
    jThumb.style.cssText = 'position:absolute;width:52px;height:52px;border-radius:50%;background:rgba(255,255,255,0.3);border:2px solid rgba(255,255,255,0.4);top:50%;left:50%;transform:translate(-50%,-50%);transition:background 0.1s;';
    joystick.appendChild(jBase);
    joystick.appendChild(jThumb);
    overlay.appendChild(joystick);

    let jActive = false;
    let jTouchId = -1;
    let jCx = 0, jCy = 0, jR = 0;
    const jKeys: Record<string, boolean> = { KeyW: false, KeyS: false, KeyA: false, KeyD: false };

    const pressKey = (code: string) => {
        if (jKeys[code]) return;
        jKeys[code] = true;
        window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
    };
    const releaseKey = (code: string) => {
        if (!jKeys[code]) return;
        jKeys[code] = false;
        window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
    };

    const updateJoystick = (cx: number, cy: number) => {
        let dx = cx - jCx, dy = cy - jCy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > jR) { dx = (dx / dist) * jR; dy = (dy / dist) * jR; }
        jThumb.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
        const nx = dx / jR, ny = dy / jR;
        const threshold = 0.3;
        ny < -threshold ? pressKey('KeyW') : releaseKey('KeyW');
        ny > threshold ? pressKey('KeyS') : releaseKey('KeyS');
        nx < -threshold ? pressKey('KeyA') : releaseKey('KeyA');
        nx > threshold ? pressKey('KeyD') : releaseKey('KeyD');
    };
    const resetJoystick = () => {
        jActive = false; jTouchId = -1;
        jThumb.style.transform = 'translate(-50%,-50%)';
        for (const k of Object.keys(jKeys)) releaseKey(k);
    };

    joystick.addEventListener('touchstart', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (jActive) return;
        const t = e.changedTouches[0];
        jActive = true; jTouchId = t.identifier;
        const r = joystick.getBoundingClientRect();
        jCx = r.left + r.width / 2; jCy = r.top + r.height / 2; jR = r.width / 2 - 26;
        updateJoystick(t.clientX, t.clientY);
    }, { passive: false });
    joystick.addEventListener('touchmove', (e) => {
        e.preventDefault(); e.stopPropagation();
        for (let i = 0; i < e.changedTouches.length; i++) {
            if (e.changedTouches[i].identifier === jTouchId) {
                updateJoystick(e.changedTouches[i].clientX, e.changedTouches[i].clientY);
                return;
            }
        }
    }, { passive: false });
    joystick.addEventListener('touchend', (e) => {
        for (let i = 0; i < e.changedTouches.length; i++) {
            if (e.changedTouches[i].identifier === jTouchId) { resetJoystick(); return; }
        }
    });
    joystick.addEventListener('touchcancel', () => resetJoystick());

    // ── Right-side action buttons ──
    const btnContainer = document.createElement('div');
    btnContainer.style.cssText = 'position:absolute;bottom:24px;right:24px;display:flex;flex-direction:column;gap:10px;pointer-events:auto;touch-action:none;';

    const makeBtn = (label: string, code: string, size: number = 60): HTMLElement => {
        const btn = document.createElement('div');
        btn.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:rgba(255,255,255,0.12);border:2px solid rgba(255,255,255,0.25);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:rgba(255,255,255,0.7);font-family:-apple-system,sans-serif;user-select:none;touch-action:none;`;
        btn.textContent = label;
        let active = false;
        btn.addEventListener('touchstart', (e) => {
            e.preventDefault(); e.stopPropagation();
            if (active) return;
            active = true;
            btn.style.background = 'rgba(255,255,255,0.3)';
            window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
        }, { passive: false });
        const up = () => {
            if (!active) return;
            active = false;
            btn.style.background = 'rgba(255,255,255,0.12)';
            window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
        };
        btn.addEventListener('touchend', (e) => { e.preventDefault(); up(); }, { passive: false });
        btn.addEventListener('touchcancel', up);
        return btn;
    };

    const jumpBtn = makeBtn('Jump', 'Space', 68);
    const shiftBtn = makeBtn('Run', 'ShiftLeft', 56);
    const eBtn = makeBtn('E', 'KeyE', 50);

    const topRow = document.createElement('div');
    topRow.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';
    topRow.appendChild(eBtn);
    topRow.appendChild(shiftBtn);
    btnContainer.appendChild(topRow);
    btnContainer.appendChild(jumpBtn);
    jumpBtn.style.alignSelf = 'flex-end';
    overlay.appendChild(btnContainer);

    // ── Settings toggle ──
    const settingsPanel = document.getElementById('settings-panel');
    if (settingsPanel) {
        const divider = document.createElement('div');
        divider.style.cssText = 'height:1px;background:rgba(255,255,255,0.08);margin:4px 0;';
        settingsPanel.appendChild(divider);

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';

        const label = document.createElement('div');
        label.className = 'settings-label';
        label.textContent = 'Touch Controls';
        label.style.marginBottom = '0';

        const toggle = document.createElement('button');
        toggle.style.cssText = 'padding:4px 12px;border:1px solid rgba(255,255,255,0.15);border-radius:6px;background:transparent;color:#aaa;font-size:12px;font-weight:500;cursor:pointer;';
        const updateToggle = () => {
            toggle.textContent = enabled ? 'On' : 'Off';
            toggle.style.background = enabled ? 'rgba(134,72,230,0.25)' : 'transparent';
            toggle.style.borderColor = enabled ? '#8648e6' : 'rgba(255,255,255,0.15)';
            toggle.style.color = enabled ? '#c9a5f7' : '#aaa';
            overlay.style.display = enabled ? '' : 'none';
        };
        toggle.addEventListener('click', () => {
            enabled = !enabled;
            localStorage.setItem(STORAGE_KEY, String(enabled));
            updateToggle();
            if (!enabled) resetJoystick();
        });
        updateToggle();

        row.appendChild(label);
        row.appendChild(toggle);
        settingsPanel.appendChild(row);
    }
}
