import { EditorContext } from '../../editor_context.js';

export interface AssetFieldOptions {
    label?: string;
    value?: string;
    assetType?: string;
    onChange?: (assetPath: string | null) => void;
}

const ASSET_TYPE_TO_CATEGORY: Record<string, string> = {
    mesh: '3D Models',
    texture: 'Textures',
    audio: 'Audio',
    animation: 'Animations',
    script: 'Scripts',
};

/**
 * Asset reference field with a preview, name display, and a clear button.
 * Clicking the name opens an asset browser popup.
 */
export class AssetField {
    readonly el: HTMLElement;
    private nameEl: HTMLElement;
    private clearBtn: HTMLButtonElement;
    private value: string | null;
    private options: AssetFieldOptions;

    constructor(options: AssetFieldOptions = {}) {
        this.options = options;
        this.value = options.value ?? null;

        this.el = document.createElement('div');
        this.el.className = 'asset-field';

        // Preview icon
        const preview = document.createElement('div');
        preview.className = 'asset-preview';
        preview.textContent = this.getIcon();
        this.el.appendChild(preview);

        // Name display
        this.nameEl = document.createElement('div');
        this.nameEl.className = 'asset-name';
        this.updateNameDisplay();
        this.el.appendChild(this.nameEl);

        this.nameEl.addEventListener('click', () => {
            this.openAssetPicker();
        });

        // Clear button
        this.clearBtn = document.createElement('button');
        this.clearBtn.className = 'asset-clear-btn';
        this.clearBtn.textContent = '\u2715';
        this.clearBtn.title = 'Clear';
        this.el.appendChild(this.clearBtn);

        this.clearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.value = null;
            this.updateNameDisplay();
            this.options.onChange?.(null);
        });

        // Drag-and-drop support for asset library items
        this.el.addEventListener('dragover', (e) => {
            if (e.dataTransfer?.types.includes('application/x-parallax-asset')) {
                e.preventDefault();
                this.el.classList.add('drag-over');
            }
        });
        this.el.addEventListener('dragleave', () => {
            this.el.classList.remove('drag-over');
        });
        this.el.addEventListener('drop', (e) => {
            this.el.classList.remove('drag-over');
            const json = e.dataTransfer?.getData('application/x-parallax-asset');
            if (!json) return;
            e.preventDefault();
            try {
                const asset = JSON.parse(json);
                if (this.isCompatibleAsset(asset)) {
                    this.value = asset.fileUrl;
                    this.updateNameDisplay();
                    this.options.onChange?.(this.value);
                }
            } catch { /* ignore invalid drag data */ }
        });
    }

    private openAssetPicker(): void {
        document.querySelector('.asset-picker-overlay')?.remove();

        const ctx = EditorContext.instance;
        const category = ASSET_TYPE_TO_CATEGORY[this.options.assetType ?? ''] ?? '';

        // Overlay
        const overlay = document.createElement('div');
        overlay.className = 'asset-picker-overlay';
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

        // Dialog
        const dialog = document.createElement('div');
        dialog.className = 'asset-picker-dialog';

        // Header
        const header = document.createElement('div');
        header.className = 'asset-picker-header';

        const title = document.createElement('div');
        title.className = 'asset-picker-title';
        title.textContent = `Select ${this.options.assetType === 'mesh' ? 'Mesh' : this.options.assetType === 'animation' ? 'Animation' : this.options.assetType === 'audio' ? 'Audio' : 'Asset'}`;
        header.appendChild(title);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'asset-picker-close';
        closeBtn.textContent = '\u2715';
        closeBtn.addEventListener('click', () => overlay.remove());
        header.appendChild(closeBtn);

        dialog.appendChild(header);

        // Search bar
        const searchBar = document.createElement('div');
        searchBar.className = 'asset-picker-search';

        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = 'Search assets...';
        searchInput.className = 'asset-picker-search-input';
        searchBar.appendChild(searchInput);

        dialog.appendChild(searchBar);

        // Grid area
        const gridContainer = document.createElement('div');
        gridContainer.className = 'asset-picker-grid-container';
        dialog.appendChild(gridContainer);

        // Pagination
        const paginationBar = document.createElement('div');
        paginationBar.className = 'asset-picker-pagination';
        dialog.appendChild(paginationBar);

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        searchInput.focus();

        let currentPage = 1;
        const pageSize = 40;

        const loadAssets = async (page: number) => {
            const query = searchInput.value.trim();
            try {
                const data = await ctx.backend.searchAssets({
                    search: query || undefined,
                    category: category || undefined,
                    page,
                    limit: pageSize,
                });
                renderGrid(data.assets ?? [], data.total ?? 0, data.page ?? 1, data.totalPages ?? 1);
            } catch {
                gridContainer.innerHTML = '<div class="asset-picker-empty">Failed to load assets</div>';
            }
        };

        const renderGrid = (assets: any[], total: number, page: number, totalPages: number) => {
            gridContainer.innerHTML = '';

            if (assets.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'asset-picker-empty';
                empty.textContent = 'No assets found';
                gridContainer.appendChild(empty);
                paginationBar.innerHTML = '';
                return;
            }

            const grid = document.createElement('div');
            grid.className = 'asset-picker-grid';

            for (const asset of assets) {
                const card = document.createElement('div');
                card.className = 'asset-picker-card';
                card.title = asset.extension ? `${asset.name}.${asset.extension}` : asset.name;

                if (this.value && asset.fileUrl === this.value) {
                    card.classList.add('selected');
                }

                const thumb = document.createElement('div');
                thumb.className = 'asset-picker-card-thumb';
                if (asset.thumbnailUrl) {
                    const img = document.createElement('img');
                    img.src = asset.thumbnailUrl;
                    img.alt = asset.name;
                    img.loading = 'lazy';
                    img.onerror = () => { img.remove(); thumb.textContent = this.getIcon(); };
                    thumb.appendChild(img);
                } else {
                    thumb.textContent = this.getIcon();
                }
                card.appendChild(thumb);

                const name = document.createElement('div');
                name.className = 'asset-picker-card-name';
                name.textContent = asset.name;
                card.appendChild(name);

                card.addEventListener('click', () => {
                    this.value = asset.fileUrl;
                    this.updateNameDisplay();
                    this.options.onChange?.(this.value);
                    overlay.remove();
                });

                grid.appendChild(card);
            }

            gridContainer.appendChild(grid);

            // Pagination controls
            paginationBar.innerHTML = '';
            if (totalPages > 1) {
                const info = document.createElement('span');
                info.className = 'asset-picker-page-info';
                info.textContent = `${(page - 1) * pageSize + 1}\u2013${Math.min(page * pageSize, total)} of ${total}`;
                paginationBar.appendChild(info);

                const prevBtn = document.createElement('button');
                prevBtn.className = 'asset-picker-page-btn';
                prevBtn.textContent = '\u2039 Prev';
                prevBtn.disabled = page <= 1;
                prevBtn.addEventListener('click', () => { currentPage = page - 1; loadAssets(currentPage); });
                paginationBar.appendChild(prevBtn);

                const nextBtn = document.createElement('button');
                nextBtn.className = 'asset-picker-page-btn';
                nextBtn.textContent = 'Next \u203A';
                nextBtn.disabled = page >= totalPages;
                nextBtn.addEventListener('click', () => { currentPage = page + 1; loadAssets(currentPage); });
                paginationBar.appendChild(nextBtn);
            }
        };

        // Debounced search
        let searchTimeout = 0;
        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            currentPage = 1;
            searchTimeout = window.setTimeout(() => loadAssets(1), 300);
        });

        // Close on Escape
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                overlay.remove();
                document.removeEventListener('keydown', onKeyDown);
            }
        };
        document.addEventListener('keydown', onKeyDown);

        // Cleanup listener when overlay is removed
        const observer = new MutationObserver(() => {
            if (!document.body.contains(overlay)) {
                document.removeEventListener('keydown', onKeyDown);
                observer.disconnect();
            }
        });
        observer.observe(document.body, { childList: true });

        loadAssets(1);
    }

    private isCompatibleAsset(asset: any): boolean {
        if (!this.options.assetType) return true;
        switch (this.options.assetType) {
            case 'script': return asset.category === 'Scripts';
            case 'mesh': return asset.category === '3D Models';
            case 'audio': return asset.category === 'Audio';
            case 'texture': return asset.category === 'Textures';
            case 'animation': return asset.category === '3D Models' && asset.extension === 'glb';
            default: return true;
        }
    }

    getValue(): string | null {
        return this.value;
    }

    setValue(v: string | null, silent: boolean = false): void {
        this.value = v;
        this.updateNameDisplay();
        if (!silent) this.options.onChange?.(v);
    }

    private updateNameDisplay(): void {
        if (this.value) {
            this.nameEl.textContent = this.value.split('/').pop() ?? this.value;
            this.nameEl.classList.add('has-value');
        } else {
            this.nameEl.textContent = 'None';
            this.nameEl.classList.remove('has-value');
        }
    }

    private getIcon(): string {
        switch (this.options.assetType) {
            case 'mesh': return '\u25A6';
            case 'texture': return '\u25A3';
            case 'material': return '\u25C9';
            case 'audio': return '\u266B';
            case 'animation': return '\u21BA';
            case 'script': return '\u{1F4DC}';
            default: return '\u25A1';
        }
    }
}
