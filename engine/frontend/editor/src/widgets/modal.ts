import { t } from '../i18n/index.js';

export interface ModalOptions {
    title: string;
    body?: HTMLElement | string;
    buttons?: { label: string; primary?: boolean; danger?: boolean; action: () => void }[];
    onClose?: () => void;
    width?: string;
    /** If false, clicking the backdrop won't close the modal. Default: true. */
    closeOnBackdrop?: boolean;
}

/**
 * Creates a centered modal dialog with a backdrop.
 */
export function showModal(options: ModalOptions): { el: HTMLElement; close: () => void } {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'modal';
    if (options.width) {
        modal.style.width = options.width;
    }

    // Header
    const header = document.createElement('div');
    header.className = 'modal-header';

    const title = document.createElement('div');
    title.className = 'modal-title';
    title.textContent = options.title;
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close';
    closeBtn.innerHTML = '&#x2715;';
    header.appendChild(closeBtn);
    modal.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'modal-body';
    if (typeof options.body === 'string') {
        body.innerHTML = options.body;
    } else if (options.body) {
        body.appendChild(options.body);
    }
    modal.appendChild(body);

    // Footer
    if (options.buttons && options.buttons.length > 0) {
        const footer = document.createElement('div');
        footer.className = 'modal-footer';

        for (const btnDef of options.buttons) {
            const btn = document.createElement('button');
            btn.textContent = btnDef.label;
            if (btnDef.primary) btn.classList.add('primary');
            if (btnDef.danger) btn.classList.add('danger');
            btn.addEventListener('click', () => {
                btnDef.action();
            });
            footer.appendChild(btn);
        }

        modal.appendChild(footer);
    }

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    // Exit pointer lock so modal can receive clicks
    try { document.exitPointerLock(); } catch { /* may not be locked */ }

    const close = () => {
        backdrop.remove();
        options.onClose?.();
    };

    closeBtn.addEventListener('click', close);
    if (options.closeOnBackdrop !== false) {
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) close();
        });
    }

    // Focus the first interactive element
    const focusable = modal.querySelector('input, button, textarea, select') as HTMLElement | null;
    if (focusable) focusable.focus();

    return { el: modal, close };
}

/**
 * Shows a prompt modal that asks for text input.
 */
export function showPromptModal(
    title: string,
    defaultValue: string = '',
    placeholder: string = '',
): Promise<string | null> {
    return new Promise((resolve) => {
        let resolved = false;
        const finish = (value: string | null) => {
            if (resolved) return;
            resolved = true;
            resolve(value);
        };

        const input = document.createElement('input');
        input.type = 'text';
        input.value = defaultValue;
        input.placeholder = placeholder;
        input.style.width = '100%';
        input.style.height = '28px';
        input.style.fontSize = '14px';

        const { close } = showModal({
            title,
            body: input,
            width: '360px',
            buttons: [
                {
                    label: t('modal.cancel'),
                    action: () => {
                        finish(null);
                        close();
                    },
                },
                {
                    label: t('modal.ok'),
                    primary: true,
                    action: () => {
                        const value = input.value.trim();
                        finish(value || null);
                        close();
                    },
                },
            ],
            onClose: () => finish(null),
        });

        input.focus();
        input.select();
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const value = input.value.trim();
                finish(value || null);
                close();
            }
        });
    });
}

/**
 * Shows a confirmation dialog.
 */
export function showConfirmModal(title: string, message: string): Promise<boolean> {
    return new Promise((resolve) => {
        let resolved = false;
        const finish = (value: boolean) => {
            if (resolved) return;
            resolved = true;
            resolve(value);
        };

        const { close } = showModal({
            title,
            body: message,
            width: '360px',
            buttons: [
                {
                    label: t('modal.cancel'),
                    action: () => {
                        finish(false);
                        close();
                    },
                },
                {
                    label: t('modal.confirm'),
                    danger: true,
                    action: () => {
                        finish(true);
                        close();
                    },
                },
            ],
            onClose: () => finish(false),
        });
    });
}
