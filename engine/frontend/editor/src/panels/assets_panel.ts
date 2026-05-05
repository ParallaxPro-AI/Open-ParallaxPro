import { EditorContext } from '../editor_context.js';
import { TabsWidget } from '../widgets/tabs.js';
import { MeshRendererComponent } from '../../../runtime/function/framework/components/mesh_renderer_component.js';
import { AudioSourceComponent } from '../../../runtime/function/framework/components/audio_source_component.js';
import { ProfilerPanel } from './profiler_panel.js';
import { ModelGenPanel } from './model_gen_panel.js';
import { t } from '../i18n/index.js';

const CATEGORY_ICONS: Record<string, string> = {
    '3D Models': '\u25A6',
    'Characters': '\u{1F9CD}',
    'Audio': '\u266B',
    'Textures': '\u25A3',
    'Scripts': '\u{1F4DC}',
};

function prettifyName(name: string): string {
    return name.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function showAssetPreview(asset: any): void {
    document.querySelector('.asset-preview-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'asset-preview-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const dialog = document.createElement('div');
    dialog.className = 'asset-preview-dialog';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'asset-preview-close';
    closeBtn.textContent = '\u2715';
    closeBtn.addEventListener('click', () => overlay.remove());
    dialog.appendChild(closeBtn);

    const previewContent = document.createElement('div');
    previewContent.className = 'asset-preview-content';

    if (asset.category === 'Audio') {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.src = asset.fileUrl;
        audio.style.width = '100%';
        previewContent.appendChild(audio);
        if (asset.thumbnailUrl) {
            const img = document.createElement('img');
            img.src = asset.thumbnailUrl;
            img.alt = asset.name;
            img.className = 'asset-preview-image';
            previewContent.insertBefore(img, audio);
        }
    } else if (asset.thumbnailUrl) {
        const img = document.createElement('img');
        img.src = asset.thumbnailUrl;
        img.alt = asset.name;
        img.className = 'asset-preview-image';
        previewContent.appendChild(img);
    } else {
        const iconEl = document.createElement('div');
        iconEl.className = 'asset-preview-icon';
        iconEl.textContent = CATEGORY_ICONS[asset.category] ?? '\u25A1';
        previewContent.appendChild(iconEl);
    }

    dialog.appendChild(previewContent);

    const info = document.createElement('div');
    info.className = 'asset-preview-info';
    const metaParts = [`<span>Category: ${asset.category}</span>`];
    if (asset.source) metaParts.push(`<span>Source: ${prettifyName(asset.source)}</span>`);
    if (asset.pack) metaParts.push(`<span>Pack: ${prettifyName(asset.pack)}</span>`);
    if (asset.extension) metaParts.push(`<span>Type: .${asset.extension}</span>`);
    let attrHtml = '';
    if (asset.attribution) {
        const lines = asset.attribution.split('\n').map((l: string) => {
            return l.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener" style="color:#6ea8fe">$1</a>');
        });
        attrHtml = `<div class="asset-preview-attribution" style="margin-top:8px;padding:6px 8px;background:#1a2233;border-radius:4px;font-size:11px;color:#aab;line-height:1.5">${lines.join('<br>')}</div>`;
    }
    info.innerHTML = `
        <div class="asset-preview-name">${asset.name}</div>
        <div class="asset-preview-meta">${metaParts.join('')}</div>
        ${attrHtml}
    `;
    dialog.appendChild(info);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

function buildAssetCard(asset: any, iconFallback: string): HTMLElement {
    const card = document.createElement('div');
    card.className = 'asset-card';
    card.title = asset.extension ? `${asset.name}.${asset.extension}` : asset.name;
    card.draggable = true;
    card.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('application/x-parallax-asset', JSON.stringify(asset));
    });
    card.addEventListener('click', () => showAssetPreview(asset));

    const thumb = document.createElement('div');
    thumb.className = 'asset-card-thumb';
    if (asset.thumbnailUrl) {
        const img = document.createElement('img');
        img.src = asset.thumbnailUrl;
        img.alt = asset.name;
        img.loading = 'lazy';
        img.onerror = () => { img.remove(); thumb.textContent = iconFallback; };
        thumb.appendChild(img);
    } else {
        thumb.textContent = iconFallback;
    }
    card.appendChild(thumb);

    const name = document.createElement('div');
    name.className = 'asset-card-name';
    name.textContent = asset.name;
    card.appendChild(name);

    return card;
}

/**
 * Assets panel: tabbed container for Project Files, Asset Library, and FSM visualization.
 */
export class AssetsPanel {
    readonly el: HTMLElement;
    private ctx: EditorContext;
    private tabs: TabsWidget;
    private profiler: ProfilerPanel;
    private modelGen: ModelGenPanel;

    constructor() {
        this.ctx = EditorContext.instance;
        this.el = document.createElement('div');
        this.el.className = 'panel assets-panel';

        const header = document.createElement('div');
        header.className = 'panel-header';
        const title = document.createElement('span');
        title.className = 'panel-title';
        title.textContent = t('assets.title');
        header.appendChild(title);
        this.el.appendChild(header);

        this.profiler = new ProfilerPanel();
        this.modelGen = new ModelGenPanel();

        this.tabs = new TabsWidget();
        this.tabs.setTabs([
            { id: 'files', label: t('assets.projectFiles'), content: this.buildProjectFilesTab() },
            { id: 'library', label: t('assets.assetLibrary'), content: this.buildAssetLibraryTab() },
            { id: 'generate', label: 'AI Generate', content: this.modelGen.el },
            { id: 'gameflow', label: t('assets.fsm'), content: this.buildGameFlowTab() },
            { id: 'profiler', label: t('assets.performance'), content: this.profiler.el },
        ]);
        // Lazy-load library on first show so the panel doesn't hit /api/engine/models
        // on every editor mount.
        this.tabs.onChange(id => { if (id === 'generate') this.modelGen.onShow(); });
        this.el.appendChild(this.tabs.el);
    }

    // ── Project Files Tab ───────────────────────────────────────────

    private buildProjectFilesTab(): HTMLElement {
        const container = document.createElement('div');
        container.className = 'project-files-tab';

        const contentArea = document.createElement('div');
        contentArea.className = 'project-files-content';
        container.appendChild(contentArea);

        const expandedCategories = new Set<string>();
        const lookupInProgress = new Set<string>();

        const fetchMissingMeta = (fileUrls: string[]) => {
            const missing = fileUrls.filter(u => !this.ctx.assetMeta.has(u) && !lookupInProgress.has(u));
            if (missing.length === 0) return;
            for (const u of missing) lookupInProgress.add(u);

            for (const url of missing) {
                const filename = url.split('/').pop() ?? url;
                const searchName = filename.replace(/\.[^.]+$/, '');
                this.ctx.backend.searchAssets({ search: searchName, limit: 5 }).then(data => {
                    const match = (data.assets ?? []).find((a: any) => a.fileUrl === url);
                    if (match) {
                        this.ctx.assetMeta.set(url, match);
                        renderProjectFiles();
                    }
                    lookupInProgress.delete(url);
                }).catch(() => { lookupInProgress.delete(url); });
            }
        };

        const renderProjectFiles = () => {
            contentArea.innerHTML = '';
            const scene = this.ctx.getActiveScene();
            const wm = this.ctx.engine?.globalContext.worldManager;

            // Scenes
            const scenesHeader = document.createElement('div');
            scenesHeader.className = 'project-section-header';
            scenesHeader.textContent = t('assets.scenes');
            contentArea.appendChild(scenesHeader);

            const scenesGrid = document.createElement('div');
            scenesGrid.className = 'asset-library-grid';
            const allScenes = wm?.getLoadedScenes() ?? [];
            for (const s of allScenes) {
                const isActive = s === scene;
                const card = document.createElement('div');
                card.className = 'asset-card' + (isActive ? ' active' : '');
                card.style.cursor = 'pointer';

                const thumb = document.createElement('div');
                thumb.className = 'asset-card-thumb';
                thumb.textContent = '\u{1F3AC}';
                card.appendChild(thumb);

                const name = document.createElement('div');
                name.className = 'asset-card-name';
                name.textContent = s.name || t('assets.untitledScene');
                card.appendChild(name);

                card.addEventListener('click', () => {
                    if (!isActive && wm) {
                        wm.setActiveScene(s.id);
                        this.ctx.engine!.setActiveScene(s as any);
                        this.ctx.emit('sceneChanged');
                    }
                });

                card.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                    const oldName = s.name || 'Untitled Scene';
                    const input = document.createElement('input');
                    input.className = 'rename-input';
                    input.value = oldName;
                    input.style.width = '100%';
                    input.style.boxSizing = 'border-box';
                    name.textContent = '';
                    name.appendChild(input);
                    input.focus();
                    input.select();

                    let committed = false;
                    const commit = () => {
                        if (committed) return;
                        committed = true;
                        const newName = input.value.trim() || oldName;
                        s.name = newName;
                        renderProjectFiles();
                        this.ctx.emit('sceneChanged');
                    };

                    input.addEventListener('blur', commit);
                    input.addEventListener('keydown', (ev) => {
                        if (ev.key === 'Enter') {
                            input.blur();
                        } else if (ev.key === 'Escape') {
                            committed = true;
                            name.textContent = oldName;
                            input.remove();
                        }
                    });
                });

                scenesGrid.appendChild(card);
            }
            contentArea.appendChild(scenesGrid);

            if (!scene) return;

            // Collect used assets
            const CATEGORIES = [
                { key: '3D Models', icon: CATEGORY_ICONS['3D Models'] },
                { key: 'Audio', icon: CATEGORY_ICONS['Audio'] },
                { key: 'Textures', icon: CATEGORY_ICONS['Textures'] },
            ];
            const categorized = new Map<string, Map<string, any>>();
            for (const cat of CATEGORIES) categorized.set(cat.key, new Map());

            for (const entity of scene.entities.values()) {
                const mr = entity.getComponent('MeshRendererComponent') as MeshRendererComponent | null;
                if (mr?.meshAsset && mr.meshType === 'custom') {
                    const meta = this.ctx.assetMeta.get(mr.meshAsset);
                    const filename = mr.meshAsset.split('/').pop() ?? mr.meshAsset;
                    const ext = filename.includes('.') ? filename.split('.').pop()! : 'glb';
                    const assetName = filename.replace(/\.[^.]+$/, '');
                    categorized.get('3D Models')!.set(mr.meshAsset, meta ?? {
                        name: assetName, category: '3D Models', extension: ext, fileUrl: mr.meshAsset,
                    });
                }

                const audio = entity.getComponent('AudioSourceComponent') as AudioSourceComponent | null;
                if (audio?.audioAssetUUID) {
                    const meta = this.ctx.assetMeta.get(audio.audioAssetUUID);
                    categorized.get('Audio')!.set(audio.audioAssetUUID, meta ?? {
                        name: audio.audioAssetUUID, category: 'Audio', extension: 'wav', fileUrl: audio.audioAssetUUID,
                    });
                }

                if (mr?.materialOverrides?.textureBundle) {
                    const texName = mr.materialOverrides.textureBundle;
                    // textureBundle can be either a bare poly_haven pack name
                    // ("wood_floor") OR a full asset path ("/assets/kenney/...
                    // /texture_01.png"). The old code blindly templated the
                    // poly_haven URL pattern, producing broken double-prefix
                    // thumbnails like "/assets/thumbnails/poly_haven/textures/
                    // /assets/kenney/.../texture_01.png.png" that 404 with
                    // every asset-panel render.
                    if (texName.startsWith('/')) {
                        // Full path — use the texture itself as both source
                        // and thumbnail. Doesn't depend on poly_haven layout.
                        const fname = texName.split('/').pop() || texName;
                        const ext = (fname.split('.').pop() || 'png').toLowerCase();
                        categorized.get('Textures')!.set(texName, {
                            name: fname.replace(/\.[^.]+$/, ''),
                            category: 'Textures', extension: ext, fileUrl: texName,
                            thumbnailUrl: texName,
                        });
                    } else {
                        const texUrl = `/assets/poly_haven/textures/${texName}/${texName}_diff_1k.jpg`;
                        categorized.get('Textures')!.set(texName, {
                            name: texName, category: 'Textures', extension: 'jpg', fileUrl: texUrl,
                            thumbnailUrl: `/assets/thumbnails/poly_haven/textures/${texName}.png`,
                        });
                    }
                }
            }

            // Collect audio URLs referenced in project scripts
            const projectScripts = this.ctx.state.projectData?.scripts as Record<string, string> | undefined;
            if (projectScripts) {
                for (const [, code] of Object.entries(projectScripts)) {
                    const audioMatches = code.matchAll(/\/assets\/[^'",\s]+\.ogg/g);
                    for (const m of audioMatches) {
                        const url = m[0];
                        const filename = url.split('/').pop() ?? url;
                        const assetName = filename.replace('.ogg', '');
                        categorized.get('Audio')!.set(url, {
                            name: assetName, category: 'Audio', extension: 'ogg', fileUrl: url,
                        });
                    }
                }
            }

            let totalAssets = 0;
            const allFileUrls: string[] = [];
            for (const assets of categorized.values()) {
                totalAssets += assets.size;
                for (const [url] of assets) allFileUrls.push(url);
            }
            if (totalAssets === 0) return;

            fetchMissingMeta(allFileUrls);

            const usedHeader = document.createElement('div');
            usedHeader.className = 'project-section-header';
            usedHeader.textContent = t('assets.usedAssets');
            contentArea.appendChild(usedHeader);

            for (const cat of CATEGORIES) {
                const assets = categorized.get(cat.key)!;
                if (assets.size === 0) continue;

                const isExpanded = expandedCategories.has(cat.key);

                const catHeader = document.createElement('div');
                catHeader.className = 'asset-category-header' + (isExpanded ? '' : ' collapsed');

                const arrow = document.createElement('span');
                arrow.className = 'asset-category-arrow';
                arrow.textContent = isExpanded ? '\u25BC' : '\u25B6';
                catHeader.appendChild(arrow);

                const labelSpan = document.createElement('span');
                labelSpan.textContent = `${cat.icon} ${cat.key}`;
                catHeader.appendChild(labelSpan);

                const countSpan = document.createElement('span');
                countSpan.className = 'asset-category-count';
                countSpan.textContent = String(assets.size);
                catHeader.appendChild(countSpan);

                contentArea.appendChild(catHeader);

                const catGrid = document.createElement('div');
                catGrid.className = 'asset-library-grid';
                catGrid.style.display = isExpanded ? '' : 'none';

                for (const [, asset] of assets) {
                    catGrid.appendChild(buildAssetCard(asset, cat.icon));
                }

                contentArea.appendChild(catGrid);

                catHeader.addEventListener('click', () => {
                    const collapsed = catHeader.classList.toggle('collapsed');
                    catGrid.style.display = collapsed ? 'none' : '';
                    arrow.textContent = collapsed ? '\u25B6' : '\u25BC';
                    if (collapsed) expandedCategories.delete(cat.key);
                    else expandedCategories.add(cat.key);
                });
            }
        };

        renderProjectFiles();

        this.ctx.on('sceneChanged', renderProjectFiles);
        this.ctx.on('entityCreated', renderProjectFiles);
        this.ctx.on('entityDeleted', renderProjectFiles);
        this.ctx.on('componentAdded', renderProjectFiles);
        this.ctx.on('componentRemoved', renderProjectFiles);

        return container;
    }

    // ── Asset Library Tab ───────────────────────────────────────────

    private buildAssetLibraryTab(): HTMLElement {
        const container = document.createElement('div');
        container.className = 'asset-library';

        const breadcrumbBar = document.createElement('div');
        breadcrumbBar.className = 'asset-library-breadcrumb';
        container.appendChild(breadcrumbBar);

        const searchDiv = document.createElement('div');
        searchDiv.className = 'asset-library-search';
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = t('assets.searchAssets');
        searchDiv.appendChild(searchInput);

        const typeFilter = document.createElement('select');
        typeFilter.className = 'asset-type-filter';
        const allOption = document.createElement('option');
        allOption.value = '';
        allOption.textContent = t('assets.allTypes');
        typeFilter.appendChild(allOption);
        for (const cat of ['3D Models', 'Characters', 'Audio', 'Textures']) {
            const opt = document.createElement('option');
            opt.value = cat;
            opt.textContent = `${CATEGORY_ICONS[cat] ?? ''} ${cat}`;
            typeFilter.appendChild(opt);
        }
        searchDiv.appendChild(typeFilter);
        container.appendChild(searchDiv);

        const content = document.createElement('div');
        content.className = 'asset-library-content';
        container.appendChild(content);

        const paginationBar = document.createElement('div');
        paginationBar.className = 'asset-library-pagination';
        container.appendChild(paginationBar);

        let navCategory = '';
        let navSource = '';
        let navPack = '';
        let currentPage = 1;
        let lastPageSize = 60;

        const renderBreadcrumb = () => {
            breadcrumbBar.innerHTML = '';
            const crumbs: { label: string; action: () => void }[] = [];

            crumbs.push({ label: t('assets.assetLibraryBreadcrumb'), action: () => { navCategory = ''; navSource = ''; navPack = ''; currentPage = 1; searchInput.value = ''; navigate(); } });
            if (navCategory) {
                crumbs.push({ label: navCategory, action: () => { navSource = ''; navPack = ''; currentPage = 1; navigate(); } });
            }
            if (navSource) {
                crumbs.push({ label: prettifyName(navSource), action: () => { navPack = ''; currentPage = 1; navigate(); } });
            }
            if (navPack) {
                crumbs.push({ label: prettifyName(navPack), action: () => {} });
            }

            for (let i = 0; i < crumbs.length; i++) {
                if (i > 0) {
                    const sep = document.createElement('span');
                    sep.className = 'breadcrumb-sep';
                    sep.textContent = '\u203A';
                    breadcrumbBar.appendChild(sep);
                }
                const span = document.createElement('span');
                span.className = 'breadcrumb-item';
                span.textContent = crumbs[i].label;
                if (i < crumbs.length - 1) {
                    span.classList.add('clickable');
                    const action = crumbs[i].action;
                    span.addEventListener('click', action);
                }
                breadcrumbBar.appendChild(span);
            }
        };

        const renderFolders = (items: { name: string; count: number }[], onClick: (name: string) => void, folderIcon: string) => {
            content.innerHTML = '';
            paginationBar.innerHTML = '';
            const list = document.createElement('div');
            list.className = 'asset-folder-list';

            for (const item of items) {
                const row = document.createElement('div');
                row.className = 'asset-folder-row';
                row.addEventListener('click', () => onClick(item.name));

                const iconEl = document.createElement('span');
                iconEl.className = 'asset-folder-icon';
                iconEl.textContent = folderIcon;
                row.appendChild(iconEl);

                const nameEl = document.createElement('span');
                nameEl.className = 'asset-folder-name';
                nameEl.textContent = prettifyName(item.name);
                row.appendChild(nameEl);

                const countEl = document.createElement('span');
                countEl.className = 'asset-folder-count';
                countEl.textContent = String(item.count);
                row.appendChild(countEl);

                list.appendChild(row);
            }

            if (items.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'asset-library-empty';
                empty.textContent = t('assets.noItemsFound');
                list.appendChild(empty);
            }

            content.appendChild(list);
        };

        const measureGridCapacity = (): number | null => {
            const grid = content.querySelector('.asset-library-grid') as HTMLElement;
            const firstCard = grid?.querySelector('.asset-card') as HTMLElement;
            if (!grid || !firstCard) return null;

            const gridRect = grid.getBoundingClientRect();
            const cardRect = firstCard.getBoundingClientRect();
            const contentH = content.clientHeight;
            if (cardRect.width === 0 || cardRect.height === 0 || contentH === 0) return null;

            const style = getComputedStyle(grid);
            const gapX = parseFloat(style.columnGap) || 0;
            const gapY = parseFloat(style.rowGap) || 0;

            const cols = Math.max(1, Math.round((gridRect.width + gapX) / (cardRect.width + gapX)));
            const rows = Math.max(1, Math.floor((contentH + gapY) / (cardRect.height + gapY)));
            return cols * rows;
        };

        const renderAssetGrid = (assets: any[], total: number, page: number, totalPages: number) => {
            content.innerHTML = '';

            if (assets.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'asset-library-empty';
                empty.textContent = t('assets.noAssetsFound');
                content.appendChild(empty);
                paginationBar.innerHTML = '';
                return;
            }

            const grid = document.createElement('div');
            grid.className = 'asset-library-grid';

            for (const asset of assets) {
                grid.appendChild(buildAssetCard(asset, CATEGORY_ICONS[asset.category] ?? '\u25A1'));
            }
            content.appendChild(grid);

            paginationBar.innerHTML = '';
            if (totalPages > 1) {
                const info = document.createElement('span');
                info.className = 'pagination-info';
                info.textContent = `${(page - 1) * lastPageSize + 1}\u2013${Math.min(page * lastPageSize, total)} of ${total}`;
                paginationBar.appendChild(info);

                const prevBtn = document.createElement('button');
                prevBtn.className = 'pagination-btn';
                prevBtn.textContent = '\u2039 Prev';
                prevBtn.disabled = page <= 1;
                prevBtn.addEventListener('click', () => { currentPage = page - 1; loadAssetsPage(); });
                paginationBar.appendChild(prevBtn);

                const nextBtn = document.createElement('button');
                nextBtn.className = 'pagination-btn';
                nextBtn.textContent = 'Next \u203A';
                nextBtn.disabled = page >= totalPages;
                nextBtn.addEventListener('click', () => { currentPage = page + 1; loadAssetsPage(); });
                paginationBar.appendChild(nextBtn);
            }

            requestAnimationFrame(() => {
                const capacity = measureGridCapacity();
                if (capacity && capacity > lastPageSize) {
                    lastPageSize = capacity;
                    loadAssetsPage();
                }
            });
        };

        const navigate = async () => {
            renderBreadcrumb();

            const query = searchInput.value.trim();
            const filterCat = typeFilter.value;
            if (query || filterCat) {
                currentPage = 1;
                loadAssetsPage();
                return;
            }

            if (!navCategory) {
                try {
                    const categories = await this.ctx.backend.getAssetCategories();
                    renderFolders(categories, (name) => { navCategory = name; navigate(); }, '\u{1F4C1}');
                } catch { /* ignore */ }
            } else if (!navSource) {
                try {
                    const data = await this.ctx.backend.browseAssets(navCategory);
                    const sources = data.sources ?? [];
                    if (sources.length === 1) {
                        navSource = sources[0].name;
                        navigate();
                        return;
                    }
                    renderFolders(sources, (name) => { navSource = name; navigate(); }, '\u{1F4C1}');
                } catch { /* ignore */ }
            } else if (!navPack) {
                try {
                    const data = await this.ctx.backend.browseAssets(navCategory, navSource);
                    const packs = (data.packs ?? []).filter((p: any) => p.name !== '');
                    if (packs.length === 0) {
                        navPack = '__flat__';
                        loadAssetsPage();
                        return;
                    }
                    if (packs.length === 1) {
                        navPack = packs[0].name;
                        navigate();
                        return;
                    }
                    renderFolders(packs, (name) => { navPack = name; currentPage = 1; navigate(); }, '\u{1F4C2}');
                } catch { /* ignore */ }
            } else {
                loadAssetsPage();
            }
        };

        const loadAssetsPage = async () => {
            const query = searchInput.value.trim();
            const filterCategory = typeFilter.value || navCategory || undefined;
            try {
                const data = await this.ctx.backend.searchAssets({
                    search: query || undefined,
                    category: filterCategory,
                    source: navSource || undefined,
                    pack: (navPack && navPack !== '__flat__') ? navPack : undefined,
                    page: currentPage,
                    limit: lastPageSize,
                });
                renderAssetGrid(data.assets ?? [], data.total ?? 0, data.page ?? 1, data.totalPages ?? 1);
            } catch { /* ignore */ }
        };

        let searchTimeout = 0;
        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            currentPage = 1;
            searchTimeout = window.setTimeout(() => {
                if (searchInput.value.trim() || typeFilter.value) {
                    renderBreadcrumb();
                    loadAssetsPage();
                } else {
                    navigate();
                }
            }, 300);
        });

        typeFilter.addEventListener('change', () => {
            currentPage = 1;
            navigate();
        });

        let resizeTimer = 0;
        const ro = new ResizeObserver(() => {
            clearTimeout(resizeTimer);
            resizeTimer = window.setTimeout(() => {
                if (content.querySelector('.asset-library-grid')) {
                    const capacity = measureGridCapacity();
                    if (capacity && capacity !== lastPageSize) {
                        lastPageSize = capacity;
                        loadAssetsPage();
                    }
                }
            }, 200);
        });
        ro.observe(content);

        navigate();

        return container;
    }

    // ── Game Flow (FSM) Tab ─────────────────────────────────────────

    private buildGameFlowTab(): HTMLElement {
        const container = document.createElement('div');
        container.style.cssText = 'padding:8px;overflow:auto;height:100%;font-family:Inter,system-ui,sans-serif;';

        // Zoom controls
        let zoomLevel = 0.8;
        const zoomBar = document.createElement('div');
        zoomBar.style.cssText = 'display:flex;gap:4px;align-items:center;margin-bottom:6px;';
        const zoomOut = document.createElement('button');
        zoomOut.textContent = '\u2212';
        zoomOut.title = 'Zoom out';
        zoomOut.style.cssText = 'width:24px;height:24px;border:1px solid rgba(255,255,255,0.15);border-radius:4px;background:rgba(20,20,28,0.8);color:#e8eaed;cursor:pointer;font-size:14px;line-height:1;';
        const zoomIn = document.createElement('button');
        zoomIn.textContent = '+';
        zoomIn.title = 'Zoom in';
        zoomIn.style.cssText = zoomOut.style.cssText;
        const zoomLabel = document.createElement('span');
        zoomLabel.style.cssText = 'font-size:11px;color:#8a8f98;min-width:36px;text-align:center;';
        zoomLabel.textContent = '80%';
        const zoomFit = document.createElement('button');
        zoomFit.textContent = 'Fit';
        zoomFit.style.cssText = 'padding:2px 8px;border:1px solid rgba(255,255,255,0.15);border-radius:4px;background:rgba(20,20,28,0.8);color:#e8eaed;cursor:pointer;font-size:10px;';
        zoomBar.appendChild(zoomOut);
        zoomBar.appendChild(zoomLabel);
        zoomBar.appendChild(zoomIn);
        zoomBar.appendChild(zoomFit);
        container.appendChild(zoomBar);

        // Pannable + zoomable viewport
        const viewport = document.createElement('div');
        viewport.style.cssText = 'overflow:hidden;position:relative;cursor:grab;flex:1;min-height:200px;border:1px solid rgba(255,255,255,0.06);border-radius:6px;background:rgba(10,10,16,0.5);';
        container.appendChild(viewport);

        const svgContainer = document.createElement('div');
        svgContainer.id = 'fsm-svg-container';
        svgContainer.style.cssText = 'transform-origin:0 0;position:absolute;top:0;left:0;';
        viewport.appendChild(svgContainer);

        let panX = 0, panY = 0;
        const applyTransform = () => {
            svgContainer.style.transform = `translate(${panX}px,${panY}px) scale(${zoomLevel})`;
            zoomLabel.textContent = Math.round(zoomLevel * 100) + '%';
        };
        zoomIn.addEventListener('click', () => { zoomLevel = Math.min(2.0, zoomLevel + 0.15); applyTransform(); });
        zoomOut.addEventListener('click', () => { zoomLevel = Math.max(0.3, zoomLevel - 0.15); applyTransform(); });
        zoomFit.addEventListener('click', () => { zoomLevel = 1.0; panX = 0; panY = 0; applyTransform(); });

        // Pan by mouse drag
        let dragging = false, dragStartX = 0, dragStartY = 0, panStartX = 0, panStartY = 0;
        viewport.addEventListener('mousedown', (e) => {
            dragging = true; dragStartX = e.clientX; dragStartY = e.clientY;
            panStartX = panX; panStartY = panY;
            viewport.style.cursor = 'grabbing';
        });
        window.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            panX = panStartX + (e.clientX - dragStartX);
            panY = panStartY + (e.clientY - dragStartY);
            applyTransform();
        });
        window.addEventListener('mouseup', () => {
            if (dragging) { dragging = false; viewport.style.cursor = 'grab'; }
        });
        viewport.addEventListener('wheel', (e) => {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -0.1 : 0.1;
            zoomLevel = Math.max(0.3, Math.min(2.0, zoomLevel + delta));
            applyTransform();
        }, { passive: false });

        // Live state bar
        const liveBar = document.createElement('div');
        liveBar.style.cssText = 'padding:8px 12px;background:rgba(20,20,28,0.8);border-radius:6px;border:1px solid rgba(255,255,255,0.08);font-size:12px;color:#8a8f98;display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:8px;';
        liveBar.innerHTML = '<span style="color:#e8eaed;font-weight:600;">State:</span><span id="fsm-panel-state" style="color:#fbbf24;">--</span><span id="fsm-panel-timer" style="color:#69bbf3;font-size:11px;"></span><span id="fsm-panel-enemies" style="color:#f87171;font-size:11px;"></span><span id="fsm-panel-pickups" style="color:#a78bfa;font-size:11px;"></span>';
        const liveVarsRow = document.createElement('div');
        liveVarsRow.id = 'fsm-panel-vars';
        liveVarsRow.style.cssText = 'font-size:11px;width:100%;';
        liveBar.appendChild(liveVarsRow);
        const liveBehaviorsRow = document.createElement('div');
        liveBehaviorsRow.id = 'fsm-panel-behaviors';
        liveBehaviorsRow.style.cssText = 'font-size:11px;width:100%;';
        liveBar.appendChild(liveBehaviorsRow);
        container.appendChild(liveBar);

        const infoBar = document.createElement('div');
        infoBar.id = 'fsm-panel-info';
        infoBar.style.cssText = 'padding:8px 12px;background:rgba(20,20,28,0.5);border-radius:6px;border:1px solid rgba(255,255,255,0.06);font-size:11px;color:#8a8f98;';
        container.appendChild(infoBar);

        // FSM graph rendering state
        let nodeRects: SVGRectElement[] = [];
        let stateNames: string[] = [];
        let config: any = null;
        let rendered = false;
        let positions: { x: number; y: number }[] = [];

        // Entity / FSM selector
        let selectedFsmIndex = 0;
        let allFsmEntries: { entity: string; scriptKey: string; configs: any[] }[] = [];

        const selectorBar = document.createElement('div');
        selectorBar.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap;';
        const entitySelect = document.createElement('select');
        entitySelect.style.cssText = 'padding:3px 6px;border:1px solid rgba(255,255,255,0.15);border-radius:4px;background:rgba(20,20,28,0.8);color:#e8eaed;font-size:11px;max-width:180px;';
        const fsmSelect = document.createElement('select');
        fsmSelect.style.cssText = entitySelect.style.cssText;
        selectorBar.appendChild(document.createTextNode('Entity: '));
        selectorBar.appendChild(entitySelect);
        selectorBar.appendChild(document.createTextNode(' FSM: '));
        selectorBar.appendChild(fsmSelect);

        // Autofocus toggle
        const autoFocusBtn = document.createElement('button');
        autoFocusBtn.textContent = 'Autofocus: ON';
        autoFocusBtn.title = 'Auto-center on active state during play';
        autoFocusBtn.style.cssText = 'padding:2px 8px;border:1px solid rgba(74,222,128,0.4);border-radius:4px;background:rgba(74,222,128,0.15);color:#4ade80;cursor:pointer;font-size:10px;margin-left:auto;';
        let autoFocus = true;
        autoFocusBtn.addEventListener('click', () => {
            autoFocus = !autoFocus;
            autoFocusBtn.textContent = 'Autofocus: ' + (autoFocus ? 'ON' : 'OFF');
            autoFocusBtn.style.borderColor = autoFocus ? 'rgba(74,222,128,0.4)' : 'rgba(255,255,255,0.15)';
            autoFocusBtn.style.background = autoFocus ? 'rgba(74,222,128,0.15)' : 'rgba(20,20,28,0.8)';
            autoFocusBtn.style.color = autoFocus ? '#4ade80' : '#8a8f98';
        });
        selectorBar.appendChild(autoFocusBtn);
        container.insertBefore(selectorBar, zoomBar);

        // Event notification feed
        const eventFeed = document.createElement('div');
        eventFeed.style.cssText = 'position:absolute;top:8px;right:8px;width:220px;max-height:180px;overflow:hidden;z-index:5;pointer-events:none;display:flex;flex-direction:column-reverse;gap:2px;';
        viewport.appendChild(eventFeed);
        const eventLog: { text: string; time: number; color: string }[] = [];
        const addEventNotification = (text: string, color: string = '#69bbf3') => {
            eventLog.unshift({ text, time: Date.now(), color });
            if (eventLog.length > 8) eventLog.pop();
            eventFeed.innerHTML = eventLog.map(e => {
                const age = (Date.now() - e.time) / 1000;
                const opacity = Math.max(0, 1 - age / 5);
                return `<div style="font-size:10px;color:${e.color};opacity:${opacity};padding:2px 6px;background:rgba(0,0,0,0.7);border-radius:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${e.text}</div>`;
            }).join('');
        };

        const scanFSMs = () => {
            const pd = this.ctx.state.projectData;
            if (!pd || !pd.scripts) return;
            allFsmEntries = [];
            for (const key of Object.keys(pd.scripts)) {
                if (!key.includes('fsm_driver')) continue;
                const src = pd.scripts[key];
                const cfgMatch = src.match(/_fsmConfigs\s*=\s*'((?:[^'\\]|\\.)*)'/s);
                if (!cfgMatch) continue;
                try {
                    // Reverse the JS single-quoted-string escape that the
                    // assembler applies when embedding the JSON payload into
                    // source. Two escapes are added: `\` → `\\` and `'` → `\'`.
                    // Reversing just `\'` (as we used to) left the doubled
                    // backslashes intact, which broke JSON.parse whenever the
                    // config contained JSON-escaped quotes — e.g.
                    // ui_params.pause_menu.pauseHint with HTML like
                    // `class="pm-kbd"` produced `\\"` in the source, which
                    // JSON.parse reads as backslash + string-terminator.
                    const configs = JSON.parse(cfgMatch[1].replace(/\\([\\'])/g, '$1'));
                    if (!Array.isArray(configs) || configs.length === 0) continue;
                    const entityName = key.replace(/^scripts\/fsm_driver_/, '').replace(/\.ts$/, '').replace(/_/g, '/');
                    const expandedConfigs = [...configs];
                    for (const cfg of configs) {
                        if (!cfg.states) continue;
                        for (const [stateName, stateObj] of Object.entries(cfg.states) as [string, any][]) {
                            if (stateObj.substates && Object.keys(stateObj.substates).length > 0) {
                                expandedConfigs.push({
                                    id: (cfg.id || entityName) + '/' + stateName,
                                    start: stateObj.start || Object.keys(stateObj.substates)[0],
                                    states: stateObj.substates,
                                    _parentState: stateName,
                                    _parentTransitions: stateObj.transitions || [],
                                });
                            }
                        }
                    }
                    allFsmEntries.push({ entity: entityName, scriptKey: key, configs: expandedConfigs });
                } catch { /* ignore malformed config */ }
            }

            // Fallback: old orchestrator_fsm format
            if (allFsmEntries.length === 0) {
                for (const key of Object.keys(pd.scripts)) {
                    if (!key.includes('orchestrator_fsm') && !key.includes('game_manager')) continue;
                    const src = pd.scripts[key];
                    const cfgMatch = src.match(/_config\s*=\s*("(?:[^"\\]|\\.)*")/s);
                    if (!cfgMatch) continue;
                    try {
                        const cfg = JSON.parse(JSON.parse(cfgMatch[1]));
                        if (cfg && cfg.states) {
                            allFsmEntries.push({ entity: 'GameManager', scriptKey: key, configs: [cfg] });
                        }
                    } catch { /* ignore */ }
                }
            }

            entitySelect.innerHTML = '';
            for (let i = 0; i < allFsmEntries.length; i++) {
                const opt = document.createElement('option');
                opt.value = String(i);
                opt.textContent = allFsmEntries[i].entity + ' (' + allFsmEntries[i].configs.length + ' FSMs)';
                entitySelect.appendChild(opt);
            }
        };

        const rebuildFsmSelect = () => {
            fsmSelect.innerHTML = '';
            const idx = parseInt(entitySelect.value) || 0;
            const entry = allFsmEntries[idx];
            if (!entry) return;
            for (let i = 0; i < entry.configs.length; i++) {
                const opt = document.createElement('option');
                opt.value = String(i);
                opt.textContent = entry.configs[i].id || ('FSM ' + (i + 1));
                fsmSelect.appendChild(opt);
            }
            selectedFsmIndex = 0;
        };

        entitySelect.addEventListener('change', () => {
            selectedFsmIndex = 0;
            lastState = '';
            rebuildFsmSelect();
            renderFSMGraph();
        });
        fsmSelect.addEventListener('change', () => {
            selectedFsmIndex = parseInt(fsmSelect.value) || 0;
            lastState = '';
            renderFSMGraph();
        });

        const rescanAndRebuild = () => {
            const pd = this.ctx.state.projectData;
            if (!pd || !pd.scripts) return;
            const prevEntityVal = entitySelect.value;
            const prevFsmVal = fsmSelect.value;
            scanFSMs();
            rebuildFsmSelect();
            if (entitySelect.querySelector(`option[value="${prevEntityVal}"]`)) {
                entitySelect.value = prevEntityVal;
                rebuildFsmSelect();
            }
            if (fsmSelect.querySelector(`option[value="${prevFsmVal}"]`)) {
                fsmSelect.value = prevFsmVal;
                selectedFsmIndex = parseInt(prevFsmVal) || 0;
            }
        };

        const renderFSMGraph = () => {
            const entryIdx = parseInt(entitySelect.value) || 0;
            const entry = allFsmEntries[entryIdx];
            if (!entry) {
                svgContainer.innerHTML = '<div style="color:#8a8f98;padding:20px;text-align:center;">Select an entity to view its FSMs.</div>';
                return;
            }
            selectedFsmIndex = Math.min(parseInt(fsmSelect.value) || 0, entry.configs.length - 1);
            config = entry.configs[selectedFsmIndex];
            if (!config) return;

            const states = config.states || {};
            stateNames = Object.keys(states);
            if (stateNames.length === 0) {
                svgContainer.innerHTML = '<div style="color:#8a8f98;padding:20px;">No states.</div>';
                return;
            }

            const nodeW = 140, nodeH = 60, padX = 120, padY = 120;

            // BFS layered layout from start state
            const adj: Record<string, string[]> = {};
            for (const name of stateNames) {
                adj[name] = [];
                const s = states[name];
                if (s.on_timeout) for (const a of s.on_timeout) { if (typeof a === 'string' && a.startsWith('goto:')) adj[name].push(a.substring(5)); }
                if (s.on_enter) for (const a of s.on_enter) { if (typeof a === 'string' && a.startsWith('goto:')) adj[name].push(a.substring(5)); }
                if (s.transitions) for (const t of s.transitions) { if (t.goto) adj[name].push(t.goto); }
            }

            const layers: string[][] = [];
            const visited = new Set<string>();
            const queue = [config.start];
            visited.add(config.start);
            while (queue.length > 0) {
                const layerSize = queue.length;
                const layer: string[] = [];
                for (let q = 0; q < layerSize; q++) {
                    const name = queue.shift()!;
                    layer.push(name);
                    for (const next of (adj[name] || [])) {
                        if (!visited.has(next) && stateNames.includes(next)) {
                            visited.add(next);
                            queue.push(next);
                        }
                    }
                }
                layers.push(layer);
            }
            for (const name of stateNames) {
                if (!visited.has(name)) {
                    if (layers.length === 0) layers.push([]);
                    layers[layers.length - 1].push(name);
                }
            }

            const orderedNames: string[] = [];
            for (const layer of layers) for (const name of layer) orderedNames.push(name);
            stateNames = orderedNames;

            const maxRows = Math.max(...layers.map(l => l.length));
            const svgW = layers.length * (nodeW + padX) + padX;
            const svgH = Math.max(maxRows, 1) * (nodeH + padY) + padY + 10;

            positions = new Array(stateNames.length);
            for (let col = 0; col < layers.length; col++) {
                const layer = layers[col];
                const totalH = layer.length * (nodeH + padY) - padY;
                const startY = (svgH - totalH) / 2;
                for (let row = 0; row < layer.length; row++) {
                    const idx = stateNames.indexOf(layer[row]);
                    positions[idx] = { x: padX + col * (nodeW + padX), y: startY + row * (nodeH + padY) };
                }
            }

            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('width', String(svgW));
            svg.setAttribute('height', String(svgH));
            svg.style.cssText = 'display:block;margin:0 auto 8px;';

            // Arrow markers
            const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
            for (const [id, clr] of [['ab', '#69bbf3'], ['ag', '#4ade80']]) {
                const m = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
                m.setAttribute('id', id); m.setAttribute('markerWidth', '8'); m.setAttribute('markerHeight', '6');
                m.setAttribute('refX', '7'); m.setAttribute('refY', '3'); m.setAttribute('orient', 'auto');
                const p = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                p.setAttribute('points', '0 0,8 3,0 6'); p.setAttribute('fill', clr);
                m.appendChild(p); defs.appendChild(m);
            }
            svg.appendChild(defs);

            // Collect and draw edges
            type Edge = { from: number; to: number; label: string; cond: boolean };
            const edges: Edge[] = [];
            const findGoto = (actions: string[]): string | null => {
                if (!actions) return null;
                for (const a of actions) { if (typeof a === 'string' && a.startsWith('goto:')) return a.substring(5); }
                return null;
            };
            for (let i = 0; i < stateNames.length; i++) {
                const s = states[stateNames[i]];
                const tgt = findGoto(s.on_timeout);
                if (tgt) { const ti = stateNames.indexOf(tgt); if (ti >= 0) edges.push({ from: i, to: ti, label: s.duration ? s.duration + 's' : 'timeout', cond: false }); }
                const eg = findGoto(s.on_enter);
                if (eg) { const ti = stateNames.indexOf(eg); if (ti >= 0 && !edges.some(e => e.from === i && e.to === ti)) edges.push({ from: i, to: ti, label: 'auto', cond: false }); }
                if (s.transitions) for (const t of s.transitions) {
                    const target = typeof t.goto === 'string' ? t.goto : (Array.isArray(t.goto) ? t.goto[0] : null) || findGoto(t.actions);
                    if (target) {
                        const ti = stateNames.indexOf(target);
                        let label = t.when || '';
                        if (label.startsWith('proximity:')) { const pp = label.substring(10).split(':'); label = 'near ' + pp[0] + (pp[1] ? ' <' + pp[1] : ''); }
                        else if (label.startsWith('health_below:')) label = 'HP<' + label.substring(13);
                        else if (label.startsWith('time_elapsed:')) label = 't>' + label.substring(13) + 's';
                        else if (label.startsWith('enemies_remaining:')) label = 'enemies=' + label.substring(18);
                        else if (label === 'pickups_collected') label = 'all pickups';
                        if (t.delay) label += ' +' + t.delay + 's';
                        if (ti >= 0) edges.push({ from: i, to: ti, label, cond: true });
                        if (Array.isArray(t.goto)) {
                            for (let ri = 1; ri < t.goto.length; ri++) {
                                const rti = stateNames.indexOf(t.goto[ri]);
                                if (rti >= 0) edges.push({ from: i, to: rti, label: label || 'random', cond: true });
                            }
                        }
                    }
                }
            }

            for (const edge of edges) {
                const f = positions[edge.from], t = positions[edge.to];
                const fcx = f.x + nodeW / 2, fcy = f.y + nodeH / 2, tcx = t.x + nodeW / 2, tcy = t.y + nodeH / 2;
                const clr = edge.cond ? '#4ade80' : '#69bbf3';
                const mRef = edge.cond ? 'url(#ag)' : 'url(#ab)';
                if (edge.from === edge.to) {
                    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    path.setAttribute('d', `M${f.x+nodeW-8},${f.y} C${f.x+nodeW+30},${f.y-40} ${f.x+nodeW+30},${f.y+nodeH+40} ${f.x+nodeW-8},${f.y+nodeH}`);
                    path.setAttribute('fill', 'none'); path.setAttribute('stroke', clr); path.setAttribute('stroke-width', '1.5');
                    path.setAttribute('marker-end', mRef); path.setAttribute('opacity', '0.7');
                    if (edge.cond) path.setAttribute('stroke-dasharray', '4,3');
                    svg.appendChild(path);
                    if (edge.label) {
                        const lt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                        lt.setAttribute('x', String(f.x+nodeW+33)); lt.setAttribute('y', String(f.y+nodeH/2+3));
                        lt.setAttribute('fill', clr); lt.setAttribute('font-size', '8'); lt.setAttribute('font-weight', '600');
                        lt.textContent = edge.label; svg.appendChild(lt);
                    }
                } else {
                    const dx = tcx - fcx, dy = tcy - fcy, dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist < 1) continue;
                    const nx = dx / dist, ny = dy / dist, px = -ny * 5, py = nx * 5;
                    const x1 = fcx + nx * (nodeW / 2 + 2) + px, y1 = fcy + ny * (nodeH / 2 + 2) + py;
                    const x2 = tcx - nx * (nodeW / 2 + 8) + px, y2 = tcy - ny * (nodeH / 2 + 8) + py;
                    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                    line.setAttribute('x1', String(x1)); line.setAttribute('y1', String(y1));
                    line.setAttribute('x2', String(x2)); line.setAttribute('y2', String(y2));
                    line.setAttribute('stroke', clr); line.setAttribute('stroke-width', '1.5');
                    line.setAttribute('marker-end', mRef); line.setAttribute('opacity', '0.7');
                    if (edge.cond) line.setAttribute('stroke-dasharray', '4,3');
                    svg.appendChild(line);
                    if (edge.label) {
                        const mx = (x1 + x2) / 2 + px * 0.8, my = (y1 + y2) / 2 + py * 0.8;
                        const pw = edge.label.length * 5 + 10;
                        const pill = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                        pill.setAttribute('x', String(mx - pw / 2)); pill.setAttribute('y', String(my - 7));
                        pill.setAttribute('width', String(pw)); pill.setAttribute('height', '14');
                        pill.setAttribute('rx', '7'); pill.setAttribute('fill', 'rgba(20,20,28,0.9)');
                        pill.setAttribute('stroke', clr); pill.setAttribute('stroke-width', '0.8');
                        svg.appendChild(pill);
                        const lt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                        lt.setAttribute('x', String(mx)); lt.setAttribute('y', String(my + 3));
                        lt.setAttribute('text-anchor', 'middle'); lt.setAttribute('fill', clr);
                        lt.setAttribute('font-size', '8'); lt.setAttribute('font-weight', '600');
                        lt.textContent = edge.label; svg.appendChild(lt);
                    }
                }
            }

            // Draw state nodes
            nodeRects = [];
            for (let i = 0; i < stateNames.length; i++) {
                const name = stateNames[i];
                const s = states[name];
                const pos = positions[i];
                const isStart = name === config.start;
                const isOverlay = config.overlays && config.overlays.includes(name);
                const hasSubs = !!(s.substates && Object.keys(s.substates).length > 0);
                const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                rect.setAttribute('x', String(pos.x)); rect.setAttribute('y', String(pos.y));
                rect.setAttribute('width', String(nodeW)); rect.setAttribute('height', String(nodeH));
                rect.setAttribute('rx', '6');
                rect.setAttribute('fill', isOverlay ? 'rgba(192,132,252,0.2)' : (isStart ? 'rgba(134,72,230,0.3)' : 'rgba(20,20,28,0.9)'));
                rect.setAttribute('stroke', isOverlay ? '#c084fc' : (isStart ? '#8648e6' : 'rgba(255,255,255,0.12)'));
                rect.setAttribute('stroke-width', isOverlay ? '2' : (isStart ? '2' : '1'));
                g.appendChild(rect); nodeRects.push(rect);

                const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                text.setAttribute('x', String(pos.x + nodeW / 2)); text.setAttribute('y', String(pos.y + 22));
                text.setAttribute('text-anchor', 'middle'); text.setAttribute('fill', '#e8eaed');
                text.setAttribute('font-size', '12'); text.setAttribute('font-weight', '700');
                text.textContent = name.replace(/_/g, ' ').toUpperCase(); g.appendChild(text);

                if (hasSubs) {
                    const subBadge = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                    subBadge.setAttribute('x', String(pos.x + nodeW / 2)); subBadge.setAttribute('y', String(pos.y + 42));
                    subBadge.setAttribute('text-anchor', 'middle'); subBadge.setAttribute('fill', '#c084fc');
                    subBadge.setAttribute('font-size', '8'); subBadge.setAttribute('font-weight', '600');
                    subBadge.textContent = Object.keys(s.substates).length + ' substates'; g.appendChild(subBadge);
                } else {
                    let yOff = 38;
                    if (s.duration > 0) {
                        const dur = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                        dur.setAttribute('x', String(pos.x + nodeW / 2)); dur.setAttribute('y', String(pos.y + yOff));
                        dur.setAttribute('text-anchor', 'middle'); dur.setAttribute('fill', '#fbbf24'); dur.setAttribute('font-size', '10');
                        dur.textContent = s.duration + 's'; g.appendChild(dur); yOff += 12;
                    }
                    const acts: string[] = [];
                    if (s.on_enter) for (const a of s.on_enter) {
                        if (typeof a === 'string' && a.startsWith('notify:')) acts.push('"' + a.substring(7) + '"');
                        else if (typeof a === 'string' && (a.includes('+') || a.includes('-') || a === 'revive_enemies' || a === 'game_won' || a === 'lose_life' || a === 'lose_life_hard' || a.startsWith('spawn_enemy:') || a === 'lock_input' || a === 'unlock_input' || a.startsWith('teleport_player:') || a.startsWith('escalate:'))) acts.push(a);
                    }
                    if (s.on_exit) for (const a of s.on_exit) { if (typeof a === 'string' && (a.includes('increment') || a === 'revive_enemies')) acts.push(a); }
                    if (acts.length > 0) {
                        const act = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                        act.setAttribute('x', String(pos.x + nodeW / 2)); act.setAttribute('y', String(pos.y + yOff));
                        act.setAttribute('text-anchor', 'middle'); act.setAttribute('fill', '#8a8f98'); act.setAttribute('font-size', '8');
                        act.textContent = acts.slice(0, 2).join(', '); g.appendChild(act);
                    }
                }
                if (isStart) {
                    const badge = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                    badge.setAttribute('x', String(pos.x + nodeW / 2)); badge.setAttribute('y', String(pos.y - 5));
                    badge.setAttribute('text-anchor', 'middle'); badge.setAttribute('fill', '#8648e6');
                    badge.setAttribute('font-size', '9'); badge.setAttribute('font-weight', '600');
                    badge.textContent = 'START'; g.appendChild(badge);
                }
                svg.appendChild(g);
            }

            svgContainer.innerHTML = '';
            svgContainer.appendChild(svg);

            // Center on start state
            const startIdx = stateNames.indexOf(config.start);
            if (startIdx >= 0) {
                const sp = positions[startIdx];
                const vw2 = viewport.clientWidth || 300;
                const vh2 = viewport.clientHeight || 200;
                panX = vw2 / 2 - (sp.x + nodeW / 2) * zoomLevel;
                panY = vh2 / 2 - (sp.y + nodeH / 2) * zoomLevel;
                applyTransform();
            }

            // Info bar
            const ib = document.getElementById('fsm-panel-info');
            if (ib) {
                let html = '';
                if (config.vars) html += '<div><b style="color:#e8eaed;">Vars:</b> ' + Object.entries(config.vars).map(([k, v]) => `<span style="color:#fbbf24;">${k}</span>=${v}`).join(', ') + '</div>';
                if (config.on) html += '<div style="margin-top:4px;"><b style="color:#e8eaed;">Events:</b> ' + Object.entries(config.on).map(([k, v]) => `<span style="color:#69bbf3;">${k}</span> -> ${(v as string[]).join(', ')}`).join(' | ') + '</div>';
                if (config.overlays && config.overlays.length > 0) html += '<div style="margin-top:4px;"><b style="color:#e8eaed;">Overlays:</b> <span style="color:#c084fc;">' + config.overlays.join(', ') + '</span></div>';
                html += '<div style="margin-top:4px;"><span style="color:#69bbf3;">--</span> timer &nbsp;<span style="color:#4ade80;">- -</span> condition</div>';
                ib.innerHTML = html;
            }

            rendered = true;
        };

        const renderFSM = () => { rescanAndRebuild(); renderFSMGraph(); };

        renderFSM();
        this.ctx.on('projectLoaded', () => setTimeout(renderFSM, 100));
        this.ctx.on('sceneChanged', () => setTimeout(renderFSM, 200));
        this.ctx.backend?.onWsMessage?.('script_written', () => setTimeout(renderFSM, 500));

        // "View FSMs" button from properties panel
        this.ctx.on('showEntityFSM', (data: any) => {
            this.tabs.setActiveTab('gameflow');
            const targetName = (data?.entityName || '').replace(/\//g, '_');
            rescanAndRebuild();
            for (let i = 0; i < allFsmEntries.length; i++) {
                if (allFsmEntries[i].entity.replace(/\//g, '_') === targetName || allFsmEntries[i].entity === data?.entityName) {
                    entitySelect.value = String(i);
                    selectedFsmIndex = 0;
                    rebuildFsmSelect();
                    renderFSMGraph();
                    break;
                }
            }
        });

        // Live update loop
        let lastState = '';
        const nodeW = 140, nodeH = 60;

        // Fade event notifications
        setInterval(() => {
            if (eventLog.length > 0) {
                eventFeed.innerHTML = eventLog.filter(e => Date.now() - e.time < 5000).map(e => {
                    const age = (Date.now() - e.time) / 1000;
                    const opacity = Math.max(0, 1 - age / 5);
                    return `<div style="font-size:10px;color:${e.color};opacity:${opacity};padding:2px 6px;background:rgba(0,0,0,0.7);border-radius:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${e.text}</div>`;
                }).join('');
            }
        }, 500);

        const liveInterval = setInterval(() => {
            if (!container.isConnected) { clearInterval(liveInterval); return; }
            if (!rendered) return;

            const engine = (this.ctx as any).engine;
            const scriptSystem = engine?.globalContext?.scriptSystem;
            const instances = (scriptSystem as any)?.instances;
            if (!instances) return;

            let fsmState = '', fsmVars: Record<string, any> = {}, fsmActive = false, fsmTimer = 0;
            const scene = engine?.globalContext?.worldManager?.activeScene;
            const allDrivers: { entityId: number; entityName: string; entityKey?: string; script: any }[] = [];

            for (const inst of instances) {
                const s = inst?.script;
                if (!s || !s._instances || !Array.isArray(s._instances)) continue;
                const entityKey = s._instances[0]?._cfg?._entityKey || '';
                const entityName = scene?.entities?.get(inst.entityId)?.name ?? '';
                allDrivers.push({ entityId: inst.entityId, entityName, entityKey, script: s });
            }

            const driverForEntry: (typeof allDrivers[0] | null)[] = [];
            for (let ei = 0; ei < allFsmEntries.length; ei++) {
                const entry = allFsmEntries[ei];
                const entryKey = entry.entity.replace(/\//g, '_');
                driverForEntry.push(allDrivers.find(d => d.entityKey === entryKey) || null);
            }

            // Update entity dropdown badges
            for (let ei = 0; ei < allFsmEntries.length; ei++) {
                const entry = allFsmEntries[ei];
                const opt = entitySelect.options[ei];
                if (!opt) continue;
                const driver = driverForEntry[ei];
                let activeCount = 0;
                const total = entry.configs.length;
                if (driver) {
                    for (const fsmInst of driver.script._instances) {
                        if (fsmInst && fsmInst._active) activeCount++;
                    }
                }
                const badge = activeCount === total ? '\u25CF' : (activeCount > 0 ? '\u25D0' : '\u25CB');
                const label = `${badge} ${entry.entity} (${activeCount}/${total})`;
                if (opt.textContent !== label) opt.textContent = label;
            }

            // Get current FSM state
            const entryIdx = parseInt(entitySelect.value) || 0;
            const selEntry = allFsmEntries[entryIdx];
            if (!selEntry) return;
            const selFsmIdx = parseInt(fsmSelect.value) || 0;
            const selDriver = driverForEntry[entryIdx];
            const selConfig = selEntry.configs[selFsmIdx];
            if (selDriver) {
                if (selConfig && selConfig._parentState) {
                    const fsmInst = selDriver.script._instances[0];
                    if (fsmInst) {
                        fsmState = fsmInst._substate || '';
                        fsmActive = !!fsmInst._active && fsmInst._state === selConfig._parentState;
                        fsmVars = fsmInst._vars || {};
                        fsmTimer = fsmInst._timer || 0;
                        (this as any)._currentSubstate = fsmInst._substate || null;
                    }
                } else if (selDriver.script._instances[selFsmIdx]) {
                    const fsmInst = selDriver.script._instances[selFsmIdx];
                    fsmState = fsmInst._state || '';
                    fsmActive = !!fsmInst._active;
                    fsmVars = fsmInst._vars || {};
                    fsmTimer = fsmInst._timer || 0;
                    (this as any)._currentSubstate = fsmInst._substate || null;
                }
            }

            // Update live bar
            const stateEl = document.getElementById('fsm-panel-state');
            if (stateEl) {
                if (!fsmActive) {
                    stateEl.textContent = 'INACTIVE';
                    stateEl.style.color = '#8a8f98';
                } else {
                    const sub = (this as any)._currentSubstate;
                    stateEl.textContent = fsmState ? (sub ? fsmState.toUpperCase() + ' > ' + sub.toUpperCase() : fsmState.toUpperCase()) : '--';
                    stateEl.style.color = '#fbbf24';
                }
            }

            const timerEl = document.getElementById('fsm-panel-timer');
            if (timerEl) {
                const configDuration = config?.states?.[fsmState]?.duration;
                const displayMax = (typeof configDuration === 'number' && configDuration > 0) ? configDuration : 0;
                if (displayMax > 0) {
                    timerEl.textContent = Math.min(Math.ceil(fsmTimer), displayMax) + 's / ' + displayMax + 's';
                } else {
                    timerEl.textContent = fsmActive ? '\u221E' : '';
                }
            }

            const varsEl = document.getElementById('fsm-panel-vars');
            if (varsEl) {
                if (Object.keys(fsmVars).length > 0) {
                    varsEl.innerHTML = Object.entries(fsmVars).map(([k, v]) => {
                        const display = typeof v === 'number' && !Number.isInteger(v) ? parseFloat((v as number).toPrecision(5)) : v;
                        return `<span style="color:#fbbf24;">${k}</span>=${display}`;
                    }).join(' &nbsp; ');
                } else {
                    varsEl.innerHTML = '<span style="color:#8a8f98;">No variables</span>';
                }
            }

            // Show active behaviors
            const behaviorsEl = document.getElementById('fsm-panel-behaviors');
            if (behaviorsEl && config) {
                let activeBehaviors: string[] = [];
                const curSub = (this as any)._currentSubstate;
                if (fsmState && config.states?.[fsmState]?.substates?.[curSub]?.active_behaviors) {
                    activeBehaviors = config.states[fsmState].substates[curSub].active_behaviors;
                } else if (fsmState && config.states?.[fsmState]?.active_behaviors) {
                    activeBehaviors = config.states[fsmState].active_behaviors;
                }
                if (activeBehaviors.length > 0) {
                    behaviorsEl.innerHTML = '<span style="color:#c084fc;font-weight:600;">Behaviors:</span> ' +
                        activeBehaviors.map((b: string) => `<span style="color:#c084fc;">${b}</span>`).join(' &nbsp; ');
                } else {
                    behaviorsEl.innerHTML = '<span style="color:#8a8f98;">No active behaviors</span>';
                }
            }

            // Highlight active state + transition notifications
            if (fsmState !== lastState) {
                const curSub = (this as any)._currentSubstate;
                const sub = curSub ? '.' + curSub : '';
                if (lastState && fsmState && fsmActive) {
                    addEventNotification(`${lastState} \u2192 ${fsmState}${sub}`, '#4ade80');
                } else if (fsmActive && fsmState && !lastState) {
                    addEventNotification(`Activated \u2192 ${fsmState}${sub}`, '#fbbf24');
                }
                lastState = fsmState;

                for (let i = 0; i < stateNames.length; i++) {
                    const active = stateNames[i] === fsmState && fsmActive;
                    const isStart = config && stateNames[i] === config.start;
                    if (active) {
                        nodeRects[i]?.setAttribute('fill', 'rgba(74,222,128,0.35)');
                        nodeRects[i]?.setAttribute('stroke', '#4ade80');
                        nodeRects[i]?.setAttribute('stroke-width', '3');
                    } else if (!fsmActive && stateNames[i] === config?.start) {
                        nodeRects[i]?.setAttribute('fill', 'rgba(138,143,152,0.15)');
                        nodeRects[i]?.setAttribute('stroke', '#4a4e56');
                        nodeRects[i]?.setAttribute('stroke-width', '1');
                    } else {
                        nodeRects[i]?.setAttribute('fill', isStart ? 'rgba(134,72,230,0.2)' : 'rgba(20,20,28,0.9)');
                        nodeRects[i]?.setAttribute('stroke', isStart ? '#8648e6' : 'rgba(255,255,255,0.12)');
                        nodeRects[i]?.setAttribute('stroke-width', isStart ? '2' : '1');
                    }
                }

                // Autofocus on active state
                if (autoFocus && fsmActive && fsmState) {
                    const activeIdx = stateNames.indexOf(fsmState);
                    if (activeIdx >= 0 && positions[activeIdx]) {
                        const sp = positions[activeIdx];
                        const vw2 = viewport.clientWidth || 300;
                        const vh2 = viewport.clientHeight || 200;
                        const targetX = vw2 / 2 - (sp.x + nodeW / 2) * zoomLevel;
                        const targetY = vh2 / 2 - (sp.y + nodeH / 2) * zoomLevel;
                        panX += (targetX - panX) * 0.3;
                        panY += (targetY - panY) * 0.3;
                        applyTransform();
                    }
                }
            }
        }, 200);

        return container;
    }
}
