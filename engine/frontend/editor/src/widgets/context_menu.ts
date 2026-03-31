export interface ContextMenuItem {
    label: string;
    shortcut?: string;
    danger?: boolean;
    disabled?: boolean;
    action?: () => void;
    separator?: boolean;
}

/**
 * Context menu widget. Creates a floating menu at the given screen position.
 * Only one context menu can be open at a time.
 */
let activeMenu: HTMLElement | null = null;
let activeBackdrop: (() => void) | null = null;

export function showContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
    hideContextMenu();

    const menu = document.createElement('div');
    menu.className = 'context-menu';

    for (const item of items) {
        if (item.separator) {
            const sep = document.createElement('div');
            sep.className = 'context-menu-separator';
            menu.appendChild(sep);
            continue;
        }

        const row = document.createElement('div');
        row.className = 'context-menu-item';
        if (item.danger) row.classList.add('danger');
        if (item.disabled) row.classList.add('disabled');

        const label = document.createElement('span');
        label.className = 'item-label';
        label.textContent = item.label;
        row.appendChild(label);

        if (item.shortcut) {
            const sc = document.createElement('span');
            sc.className = 'item-shortcut';
            sc.textContent = item.shortcut;
            row.appendChild(sc);
        }

        if (item.action && !item.disabled) {
            row.addEventListener('click', (e) => {
                e.stopPropagation();
                hideContextMenu();
                item.action!();
            });
        }

        menu.appendChild(row);
    }

    document.body.appendChild(menu);

    // Position the menu, keeping it within viewport bounds
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = x;
    let top = y;

    if (left + rect.width > vw) left = vw - rect.width - 4;
    if (top + rect.height > vh) top = vh - rect.height - 4;
    if (left < 0) left = 4;
    if (top < 0) top = 4;

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    activeMenu = menu;

    // Close on click outside
    const closeHandler = (e: MouseEvent) => {
        if (!menu.contains(e.target as Node)) {
            hideContextMenu();
        }
    };
    window.addEventListener('mousedown', closeHandler, { once: true, capture: true });
    activeBackdrop = () => {
        window.removeEventListener('mousedown', closeHandler, { capture: true });
    };
}

export function hideContextMenu(): void {
    if (activeMenu) {
        activeMenu.remove();
        activeMenu = null;
    }
    if (activeBackdrop) {
        activeBackdrop();
        activeBackdrop = null;
    }
}
