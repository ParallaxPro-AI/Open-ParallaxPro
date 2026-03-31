export interface TabDefinition {
    id: string;
    label: string;
    content: HTMLElement;
}

/**
 * Simple tab bar widget that switches between content panels.
 */
export class TabsWidget {
    readonly el: HTMLElement;
    private tabBar: HTMLElement;
    private contentContainer: HTMLElement;
    private tabs: TabDefinition[] = [];
    private activeTabId: string = '';
    private onTabChange: ((tabId: string) => void) | null = null;

    constructor() {
        this.el = document.createElement('div');
        this.el.style.display = 'flex';
        this.el.style.flexDirection = 'column';
        this.el.style.flex = '1';
        this.el.style.overflow = 'hidden';

        this.tabBar = document.createElement('div');
        this.tabBar.className = 'tab-bar';
        this.el.appendChild(this.tabBar);

        this.contentContainer = document.createElement('div');
        this.contentContainer.style.flex = '1';
        this.contentContainer.style.overflow = 'hidden';
        this.contentContainer.style.display = 'flex';
        this.contentContainer.style.flexDirection = 'column';
        this.el.appendChild(this.contentContainer);
    }

    setTabs(tabs: TabDefinition[]): void {
        this.tabs = tabs;
        this.render();
        if (tabs.length > 0 && !this.activeTabId) {
            this.setActiveTab(tabs[0].id);
        }
    }

    setActiveTab(tabId: string): void {
        this.activeTabId = tabId;
        this.updateVisuals();
        this.onTabChange?.(tabId);
    }

    onChange(callback: (tabId: string) => void): void {
        this.onTabChange = callback;
    }

    private render(): void {
        this.tabBar.innerHTML = '';
        this.contentContainer.innerHTML = '';

        for (const tab of this.tabs) {
            const tabItem = document.createElement('div');
            tabItem.className = 'tab-item';
            tabItem.textContent = tab.label;
            tabItem.addEventListener('click', () => this.setActiveTab(tab.id));
            this.tabBar.appendChild(tabItem);

            const content = document.createElement('div');
            content.className = 'tab-content';
            content.dataset.tabId = tab.id;
            content.appendChild(tab.content);
            this.contentContainer.appendChild(content);
        }

        this.updateVisuals();
    }

    private updateVisuals(): void {
        const tabItems = this.tabBar.querySelectorAll('.tab-item');
        tabItems.forEach((item, index) => {
            item.classList.toggle('active', this.tabs[index]?.id === this.activeTabId);
        });

        const contents = this.contentContainer.querySelectorAll('.tab-content');
        contents.forEach((content) => {
            const el = content as HTMLElement;
            el.classList.toggle('active', el.dataset.tabId === this.activeTabId);
        });
    }
}
