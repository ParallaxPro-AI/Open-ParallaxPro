import { showModal } from './modal.js';

export interface CloudConflictPayload {
    current: {
        id: string;
        name: string;
        thumbnail: string | null;
        updatedAt: string;
        editedEngineHash: string | null;
        projectData: { projectConfig?: any; files?: Record<string, any> };
    };
    message?: string;
}

export interface CloudConflictActions {
    keepMine: () => Promise<void> | void;
    keepRemote: () => Promise<void> | void;
    keepBoth: () => Promise<void> | void;
}

export function showCloudConflictModal(payload: CloudConflictPayload, actions: CloudConflictActions): void {
    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.5;';

    const head = document.createElement('div');
    head.style.cssText = 'color:var(--text-primary);';
    head.textContent = payload.message
        || 'This project was modified on parallaxpro.ai since your last sync. Pick which copy to keep.';
    body.appendChild(head);

    const meta = document.createElement('div');
    meta.style.cssText = 'background:var(--bg-secondary);padding:10px 12px;border-radius:6px;font-size:11.5px;color:var(--text-secondary);display:flex;flex-direction:column;gap:4px;';
    meta.innerHTML =
        `<div>Remote name:&nbsp;<strong style="color:var(--text-primary);">${escapeHtml(payload.current.name)}</strong></div>` +
        `<div>Remote updated:&nbsp;<strong style="color:var(--text-primary);">${escapeHtml(payload.current.updatedAt)}</strong></div>`;
    body.appendChild(meta);

    const choices = document.createElement('div');
    choices.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

    const makeChoice = (title: string, help: string, onClick: () => void): HTMLElement => {
        const btn = document.createElement('button');
        btn.style.cssText = 'text-align:left;padding:10px 12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);cursor:pointer;display:flex;flex-direction:column;gap:3px;';
        const t = document.createElement('div');
        t.style.cssText = 'font-weight:600;';
        t.textContent = title;
        const h = document.createElement('div');
        h.style.cssText = 'font-size:11.5px;color:var(--text-secondary);';
        h.textContent = help;
        btn.appendChild(t); btn.appendChild(h);
        btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--bg-input)'; });
        btn.addEventListener('mouseleave', () => { btn.style.background = 'var(--bg-secondary)'; });
        btn.addEventListener('click', onClick);
        return btn;
    };

    let close = () => {};

    choices.appendChild(makeChoice(
        'Keep mine — overwrite parallaxpro.ai',
        'Pushes your local version up, replacing what\'s there.',
        async () => { close(); await actions.keepMine(); },
    ));
    choices.appendChild(makeChoice(
        'Keep remote — discard local changes',
        'Pulls parallaxpro.ai\'s version down and overwrites your local copy.',
        async () => { close(); await actions.keepRemote(); },
    ));
    choices.appendChild(makeChoice(
        'Keep both — fork local into a new project',
        'Saves your local changes as a new local-only project, then pulls the remote version here.',
        async () => { close(); await actions.keepBoth(); },
    ));

    body.appendChild(choices);

    const modal = showModal({
        title: 'Sync conflict',
        body, width: '460px', closeOnBackdrop: false,
        buttons: [{ label: 'Cancel', action: () => close() }],
    });
    close = modal.close;
}

function escapeHtml(s: string): string {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]!));
}
