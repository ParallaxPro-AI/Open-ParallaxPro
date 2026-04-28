export class MobileEditorLayout {
    readonly el: HTMLElement;
    readonly viewportContainer: HTMLElement;
    readonly chatContainer: HTMLElement;
    readonly chatToggleBtn: HTMLElement;

    private divider: HTMLElement;
    private chatSheet: HTMLElement;
    private chatSheetContent: HTMLElement;
    private chatSheetOpen: boolean = false;
    private landscapeQuery: MediaQueryList;
    private unreadDot: HTMLElement;

    constructor() {
        this.el = document.createElement('div');
        this.el.className = 'mobile-editor-body';

        this.viewportContainer = document.createElement('div');
        this.viewportContainer.className = 'mobile-viewport-container';

        this.divider = document.createElement('div');
        this.divider.className = 'mobile-divider';
        const handle = document.createElement('div');
        handle.className = 'mobile-divider-handle';
        this.divider.appendChild(handle);

        this.chatContainer = document.createElement('div');
        this.chatContainer.className = 'mobile-chat-container';

        this.el.appendChild(this.viewportContainer);
        this.el.appendChild(this.divider);
        this.el.appendChild(this.chatContainer);

        this.chatToggleBtn = document.createElement('button');
        this.chatToggleBtn.className = 'mobile-chat-toggle';
        this.chatToggleBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`;
        this.unreadDot = document.createElement('div');
        this.unreadDot.className = 'unread-dot';
        this.chatToggleBtn.appendChild(this.unreadDot);
        this.chatToggleBtn.addEventListener('click', () => this.toggleChat());
        this.viewportContainer.appendChild(this.chatToggleBtn);

        this.chatSheet = document.createElement('div');
        this.chatSheet.className = 'mobile-chat-sheet';
        const sheetHandle = document.createElement('div');
        sheetHandle.className = 'mobile-chat-sheet-handle';
        sheetHandle.addEventListener('click', () => this.toggleChat());
        this.chatSheet.appendChild(sheetHandle);
        this.chatSheetContent = document.createElement('div');
        this.chatSheetContent.style.cssText = 'flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0;';
        this.chatSheet.appendChild(this.chatSheetContent);
        this.viewportContainer.appendChild(this.chatSheet);

        this.setupDivider();

        this.landscapeQuery = window.matchMedia('(orientation: landscape)');
        this.landscapeQuery.addEventListener('change', () => this.onOrientationChange());
        this.onOrientationChange();
    }

    setUnread(hasUnread: boolean): void {
        this.unreadDot.style.display = hasUnread ? 'block' : 'none';
    }

    getChatSheetContent(): HTMLElement {
        return this.chatSheetContent;
    }

    isChatSheetOpen(): boolean {
        return this.chatSheetOpen;
    }

    toggleChat(): void {
        this.chatSheetOpen = !this.chatSheetOpen;
        this.chatSheet.classList.toggle('open', this.chatSheetOpen);
        if (this.chatSheetOpen) {
            this.unreadDot.style.display = 'none';
        }
        this.onChatSheetChangeCb?.(this.chatSheetOpen);
    }

    onChatSheetChange(cb: (open: boolean) => void): void {
        this.onChatSheetChangeCb = cb;
    }
    private onChatSheetChangeCb: ((open: boolean) => void) | null = null;

    private onOrientationChange(): void {
        const isLandscape = this.landscapeQuery.matches;
        if (isLandscape) {
            this.chatSheetOpen = false;
            this.chatSheet.classList.remove('open');
        }
    }

    private setupDivider(): void {
        let startY = 0;
        let startTopHeight = 0;

        const onTouchStart = (e: TouchEvent) => {
            if (e.touches.length !== 1) return;
            e.preventDefault();
            startY = e.touches[0].clientY;
            startTopHeight = this.viewportContainer.getBoundingClientRect().height;
            document.body.style.userSelect = 'none';
            window.addEventListener('touchmove', onTouchMove, { passive: false });
            window.addEventListener('touchend', onTouchEnd);
        };

        const onTouchMove = (e: TouchEvent) => {
            e.preventDefault();
            const dy = e.touches[0].clientY - startY;
            const containerHeight = this.el.getBoundingClientRect().height;
            const newHeight = startTopHeight + dy;
            const minTop = containerHeight * 0.25;
            const maxTop = containerHeight * 0.75;
            const clamped = Math.max(minTop, Math.min(maxTop, newHeight));
            this.viewportContainer.style.flex = 'none';
            this.viewportContainer.style.height = `${clamped}px`;
            this.chatContainer.style.flex = '1';
        };

        const onTouchEnd = () => {
            document.body.style.userSelect = '';
            window.removeEventListener('touchmove', onTouchMove);
            window.removeEventListener('touchend', onTouchEnd);
        };

        this.divider.addEventListener('touchstart', onTouchStart, { passive: false });

        let mouseStartY = 0;
        let mouseStartHeight = 0;

        const onMouseDown = (e: MouseEvent) => {
            e.preventDefault();
            mouseStartY = e.clientY;
            mouseStartHeight = this.viewportContainer.getBoundingClientRect().height;
            document.body.style.cursor = 'row-resize';
            document.body.style.userSelect = 'none';
            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
        };

        const onMouseMove = (e: MouseEvent) => {
            const dy = e.clientY - mouseStartY;
            const containerHeight = this.el.getBoundingClientRect().height;
            const newHeight = mouseStartHeight + dy;
            const minTop = containerHeight * 0.25;
            const maxTop = containerHeight * 0.75;
            const clamped = Math.max(minTop, Math.min(maxTop, newHeight));
            this.viewportContainer.style.flex = 'none';
            this.viewportContainer.style.height = `${clamped}px`;
            this.chatContainer.style.flex = '1';
        };

        const onMouseUp = () => {
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };

        this.divider.addEventListener('mousedown', onMouseDown);
    }
}
