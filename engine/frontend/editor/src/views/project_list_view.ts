import { EditorContext } from '../editor_context.js';
import { showConfirmModal, showPromptModal, showModal } from '../widgets/modal.js';
import { showContextMenu } from '../widgets/context_menu.js';
import { icon, MoreVertical, Check, FolderOpen, Plus, LogOut, ExternalLink } from '../widgets/icons.js';

export class ProjectListView {
    readonly el: HTMLElement;
    private ctx: EditorContext;
    private gridEl: HTMLElement;
    private paginationEl: HTMLElement;
    private toolbarEl: HTMLElement;
    private selectCountEl: HTMLElement;
    private selectAllCheckbox: HTMLElement;
    private searchInput: HTMLInputElement;
    private projects: any[] = [];
    private selectedIds: Set<string> = new Set();
    private onOpenProject: ((projectId: string, initialPrompt?: string) => void) | null = null;
    private searchQuery: string = '';
    private statusFilter: 'all' | 'published' | 'draft' = 'all';
    private currentPage: number = 1;
    private readonly pageSize: number = 10;
    private activeTab: 'my' | 'shared' = 'my';
    private tabBar!: HTMLElement;
    private statusFilterEl!: HTMLSelectElement;

    constructor() {
        this.ctx = EditorContext.instance;
        this.el = document.createElement('div');
        this.el.className = 'project-list-view';

        const header = document.createElement('div');
        header.className = 'project-list-header';

        const logoLink = document.createElement('a');
        logoLink.href = `${import.meta.env.BASE_URL}`;
        logoLink.className = 'logo-link';
        const logo = document.createElement('img');
        logo.className = 'toolbar-logo';
        logo.src = `${import.meta.env.BASE_URL}logos/main_logo_horizontal.png`;
        logo.alt = 'ParallaxPro';
        logoLink.appendChild(logo);
        header.appendChild(logoLink);

        const spacer = document.createElement('div');
        spacer.className = 'toolbar-spacer';
        header.appendChild(spacer);

        const createBtn = document.createElement('button');
        createBtn.className = 'toolbar-btn publish-btn';
        createBtn.textContent = '+ New Project';
        createBtn.addEventListener('click', () => this.createProject());
        header.appendChild(createBtn);

        const exitBtn = document.createElement('button');
        exitBtn.className = 'toolbar-btn exit-btn';
        exitBtn.appendChild(icon(LogOut, 15));
        const exitLabel = document.createElement('span');
        exitLabel.textContent = ' Exit';
        exitBtn.appendChild(exitLabel);
        exitBtn.title = 'Back to landing page';
        exitBtn.addEventListener('click', () => {
            window.location.href = '/';
        });
        header.appendChild(exitBtn);

        this.el.appendChild(header);

        this.toolbarEl = document.createElement('div');
        this.toolbarEl.className = 'project-list-toolbar';
        this.toolbarEl.style.display = 'none';

        this.selectAllCheckbox = document.createElement('div');
        this.selectAllCheckbox.className = 'project-select-all-checkbox';
        this.selectAllCheckbox.addEventListener('click', () => this.toggleSelectAll());
        this.toolbarEl.appendChild(this.selectAllCheckbox);

        const selectAllLabel = document.createElement('span');
        selectAllLabel.className = 'select-all-label';
        selectAllLabel.textContent = 'Select All';
        selectAllLabel.style.cursor = 'pointer';
        selectAllLabel.addEventListener('click', () => this.toggleSelectAll());
        this.toolbarEl.appendChild(selectAllLabel);

        this.selectCountEl = document.createElement('span');
        this.selectCountEl.className = 'select-count';
        this.toolbarEl.appendChild(this.selectCountEl);

        const deleteSelBtn = document.createElement('button');
        deleteSelBtn.className = 'danger';
        deleteSelBtn.textContent = 'Delete Selected';
        deleteSelBtn.addEventListener('click', () => this.deleteSelected());
        this.toolbarEl.appendChild(deleteSelBtn);

        this.el.appendChild(this.toolbarEl);

        const searchRow = document.createElement('div');
        searchRow.className = 'project-search-row';

        this.searchInput = document.createElement('input');
        this.searchInput.type = 'text';
        this.searchInput.className = 'project-search-input';
        this.searchInput.placeholder = 'Search projects...';
        this.searchInput.addEventListener('input', () => {
            this.searchQuery = this.searchInput.value.trim().toLowerCase();
            this.currentPage = 1;
            this.pushPageToUrl();
            this.render();
        });
        searchRow.appendChild(this.searchInput);

        this.statusFilterEl = document.createElement('select');
        this.statusFilterEl.className = 'project-status-filter';
        this.statusFilterEl.innerHTML = '<option value="all">All</option><option value="published">Published</option><option value="draft">Draft</option>';
        this.statusFilterEl.addEventListener('change', () => {
            this.statusFilter = this.statusFilterEl.value as 'all' | 'published' | 'draft';
            this.currentPage = 1;
            this.render();
        });
        searchRow.appendChild(this.statusFilterEl);

        this.el.appendChild(searchRow);

        this.tabBar = document.createElement('div');
        this.tabBar.className = 'project-tabs';

        const myTab = document.createElement('button');
        myTab.className = 'project-tab active';
        myTab.textContent = 'My Projects';
        myTab.addEventListener('click', () => {
            if (this.activeTab === 'my') return;
            this.activeTab = 'my';
            myTab.classList.add('active');
            sharedTab.classList.remove('active');
            this.currentPage = 1;
            this.loadProjects();
        });
        this.tabBar.appendChild(myTab);

        const sharedTab = document.createElement('button');
        sharedTab.className = 'project-tab';
        sharedTab.textContent = 'Shared with me';
        sharedTab.addEventListener('click', () => {
            if (this.activeTab === 'shared') return;
            this.activeTab = 'shared';
            sharedTab.classList.add('active');
            myTab.classList.remove('active');
            this.currentPage = 1;
            this.selectedIds.clear();
            this.loadProjects();
        });
        this.tabBar.appendChild(sharedTab);

        this.el.appendChild(this.tabBar);

        this.gridEl = document.createElement('div');
        this.gridEl.className = 'project-grid';
        this.el.appendChild(this.gridEl);

        this.paginationEl = document.createElement('div');
        this.paginationEl.className = 'project-pagination';
        this.el.appendChild(this.paginationEl);

        const pageParam = new URLSearchParams(window.location.search).get('page');
        if (pageParam) this.currentPage = Math.max(1, parseInt(pageParam) || 1);

        this.loadProjects();
    }

    onOpen(callback: (projectId: string, initialPrompt?: string) => void): void {
        this.onOpenProject = callback;
    }

    private pushPageToUrl(): void {
        const url = new URL(window.location.href);
        if (this.currentPage > 1) {
            url.searchParams.set('page', String(this.currentPage));
        } else {
            url.searchParams.delete('page');
        }
        window.history.replaceState({}, '', url.toString());
    }

    private async loadProjects(): Promise<void> {
        try {
            if (this.activeTab === 'shared') {
                this.projects = await this.ctx.backend.listSharedProjects();
            } else {
                this.projects = await this.ctx.backend.listProjects();

                if (this.ctx.backend.isSelfHosted) {
                    // Best-effort merge of parallaxpro.ai publish state onto
                    // the local project list: requires a valid cli-login
                    // token AND network reachability. getPublishInfoProd
                    // swallows errors and returns {}, so offline / logged-
                    // out users just see their plain local projects with
                    // no publish badges.
                    const { readPublishMap } = await import('../backend/publish_map.js');
                    const [prodInfo, map] = [await this.ctx.backend.getPublishInfoProd(), readPublishMap()];
                    for (const p of this.projects) {
                        const mapping = map[p.id];
                        if (!mapping) continue;
                        const info = prodInfo[mapping.prodProjectId];
                        if (!info) continue;
                        p.publishedSlug = info.publishedSlug;
                        p.publishedOwner = info.publishedOwner;
                        p.publishedVersion = info.publishedVersion;
                        p.status = 'published';
                        if (info.thumbnail) {
                            // prod serves thumbnails at parallaxpro.ai/uploads/…
                            // — absolute URL so the <img> doesn't get proxied
                            // to the local backend, which has no copy.
                            p.thumbnail = info.thumbnail.startsWith('http')
                                ? info.thumbnail
                                : `https://parallaxpro.ai${info.thumbnail}`;
                        }
                    }
                } else {
                    // Hosted path — local backend IS prod, same-key lookup works.
                    const pubInfo = await this.ctx.backend.getPublishInfo();
                    for (const p of this.projects) {
                        const info = pubInfo[p.id];
                        if (info) {
                            p.publishedSlug = info.publishedSlug;
                            p.publishedOwner = info.publishedOwner;
                            p.publishedVersion = info.publishedVersion;
                        }
                    }
                }
            }
        } catch {
            this.projects = [];
        }
        this.render();
    }

    private getFilteredProjects(): any[] {
        let result = this.projects;
        if (this.searchQuery) {
            result = result.filter(p =>
                (p.name ?? '').toLowerCase().includes(this.searchQuery)
            );
        }
        if (this.statusFilter !== 'all') {
            result = result.filter(p => {
                const isPublished = p.status === 'published' && p.publishedSlug;
                return this.statusFilter === 'published' ? isPublished : !isPublished;
            });
        }
        return result;
    }

    private render(): void {
        this.gridEl.innerHTML = '';

        const filtered = this.getFilteredProjects();

        if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'project-empty-state';
            empty.style.gridColumn = '1 / -1';

            const emptyIcon = document.createElement('div');
            emptyIcon.className = 'empty-icon';
            emptyIcon.appendChild(icon(FolderOpen, 48));
            empty.appendChild(emptyIcon);

            const text = document.createElement('div');
            text.className = 'empty-text';
            text.textContent = this.searchQuery
                ? 'No projects match your search.'
                : 'No projects yet. Create your first game!';
            empty.appendChild(text);

            this.gridEl.appendChild(empty);
            this.paginationEl.innerHTML = '';
            return;
        }

        const totalPages = Math.ceil(filtered.length / this.pageSize);
        if (this.currentPage > totalPages) this.currentPage = totalPages;
        const start = (this.currentPage - 1) * this.pageSize;
        const pageProjects = filtered.slice(start, start + this.pageSize);

        for (const project of pageProjects) {
            this.gridEl.appendChild(this.createProjectCard(project));
        }

        this.renderPagination(totalPages, filtered.length);
    }

    private renderPagination(totalPages: number, totalItems: number): void {
        this.paginationEl.innerHTML = '';
        if (totalPages <= 1) return;

        const info = document.createElement('span');
        info.className = 'pagination-info';
        const start = (this.currentPage - 1) * this.pageSize + 1;
        const end = Math.min(this.currentPage * this.pageSize, totalItems);
        info.textContent = `${start}–${end} of ${totalItems}`;
        this.paginationEl.appendChild(info);

        const prevBtn = document.createElement('button');
        prevBtn.className = 'pagination-btn';
        prevBtn.textContent = '\u2039 Prev';
        prevBtn.disabled = this.currentPage <= 1;
        prevBtn.addEventListener('click', () => {
            if (this.currentPage > 1) {
                this.currentPage--;
                this.pushPageToUrl();
                this.render();
            }
        });
        this.paginationEl.appendChild(prevBtn);

        for (let i = 1; i <= totalPages; i++) {
            if (i === 1 || i === totalPages || Math.abs(i - this.currentPage) <= 1) {
                const pageBtn = document.createElement('button');
                pageBtn.className = 'pagination-btn' + (i === this.currentPage ? ' active' : '');
                pageBtn.textContent = String(i);
                pageBtn.addEventListener('click', () => {
                    this.currentPage = i;
                    this.pushPageToUrl();
                    this.render();
                });
                this.paginationEl.appendChild(pageBtn);
            } else if (i === 2 && this.currentPage > 3 || i === totalPages - 1 && this.currentPage < totalPages - 2) {
                const dots = document.createElement('span');
                dots.className = 'pagination-dots';
                dots.textContent = '\u2026';
                this.paginationEl.appendChild(dots);
            }
        }

        const nextBtn = document.createElement('button');
        nextBtn.className = 'pagination-btn';
        nextBtn.textContent = 'Next \u203A';
        nextBtn.disabled = this.currentPage >= totalPages;
        nextBtn.addEventListener('click', () => {
            if (this.currentPage < totalPages) {
                this.currentPage++;
                this.pushPageToUrl();
                this.render();
            }
        });
        this.paginationEl.appendChild(nextBtn);
    }

    private createProjectCard(project: any): HTMLElement {
        const card = document.createElement('div');
        card.className = 'project-card';
        if (this.selectedIds.has(project.id)) card.classList.add('selected');

        if (this.activeTab !== 'shared') {
            const checkbox = document.createElement('div');
            checkbox.className = 'project-card-checkbox';
            if (this.selectedIds.has(project.id)) {
                checkbox.classList.add('checked');
                checkbox.appendChild(icon(Check, 14));
            }
            checkbox.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleSelect(project.id);
            });
            card.appendChild(checkbox);
        }

        const thumb = document.createElement('div');
        thumb.className = 'project-card-thumbnail';
        if (project.thumbnail) {
            const img = document.createElement('img');
            img.src = project.thumbnail;
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = 'cover';
            thumb.appendChild(img);
        } else {
            thumb.appendChild(icon(FolderOpen, 40, { stroke: '#ccc' }));
        }
        card.appendChild(thumb);

        const info = document.createElement('div');
        info.className = 'project-card-info';

        const nameRow = document.createElement('div');
        nameRow.className = 'project-card-name-row';

        const name = document.createElement('div');
        name.className = 'project-card-name';
        name.textContent = project.name ?? 'Untitled';
        nameRow.appendChild(name);

        const isPublished = project.status === 'published' && project.publishedSlug;
        const badge = document.createElement('span');
        if (project.legacy) {
            badge.className = 'project-status-badge deprecated';
            badge.textContent = 'DEPRECATED';
            badge.title = 'Stored in the pre-template-unification format. Click the project to learn how to open it.';
        } else {
            badge.className = `project-status-badge ${isPublished ? 'published' : 'draft'}`;
            const versionInfo = project.publishedVersion ? ` V${project.publishedVersion}` : '';
            badge.textContent = isPublished ? `PUBLISHED${versionInfo}` : 'Draft';
        }
        nameRow.appendChild(badge);

        info.appendChild(nameRow);

        if (project.legacy) {
            card.classList.add('legacy');
        }

        if (this.activeTab === 'shared' && project.ownerUsername) {
            const sharedByRow = document.createElement('div');
            sharedByRow.className = 'project-card-shared-by';
            sharedByRow.textContent = `Shared by ${project.ownerUsername}`;
            info.appendChild(sharedByRow);
        }

        if (isPublished) {
            const linkRow = document.createElement('a');
            const playUrl = `${window.location.origin}/games/${project.publishedOwner}/${project.publishedSlug}`;
            linkRow.href = playUrl;
            linkRow.target = '_blank';
            linkRow.className = 'project-published-link';
            linkRow.addEventListener('click', (e) => e.stopPropagation());
            linkRow.appendChild(icon(ExternalLink, 12));
            const linkText = document.createElement('span');
            linkText.textContent = `/games/${project.publishedOwner}/${project.publishedSlug}`;
            linkRow.appendChild(linkText);
            info.appendChild(linkRow);
        }

        const bottom = document.createElement('div');
        bottom.className = 'project-card-bottom';

        const dates = document.createElement('div');
        dates.className = 'project-card-dates';

        if (project.createdAt) {
            const created = document.createElement('div');
            created.className = 'project-card-date';
            created.textContent = `Created: ${new Date(project.createdAt.endsWith('Z') ? project.createdAt : project.createdAt + 'Z').toLocaleString()}`;
            dates.appendChild(created);
        }

        if (project.updatedAt) {
            const modified = document.createElement('div');
            modified.className = 'project-card-date';
            modified.textContent = `Modified: ${new Date(project.updatedAt.endsWith('Z') ? project.updatedAt : project.updatedAt + 'Z').toLocaleString()}`;
            dates.appendChild(modified);
        }

        bottom.appendChild(dates);

        const actions = document.createElement('div');
        actions.className = 'project-card-actions';

        const menuBtn = document.createElement('button');
        menuBtn.className = 'menu-btn';
        menuBtn.title = 'More actions';
        menuBtn.appendChild(icon(MoreVertical, 16));
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showProjectMenu(project, e.clientX, e.clientY);
        });
        actions.appendChild(menuBtn);

        bottom.appendChild(actions);
        info.appendChild(bottom);
        card.appendChild(info);

        card.addEventListener('click', () => {
            if (project.legacy) {
                this.showDeprecatedModal(project);
                return;
            }
            this.onOpenProject?.(project.id);
        });

        card.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showProjectMenu(project, e.clientX, e.clientY);
        });

        return card;
    }

    private showDeprecatedModal(project: any): void {
        const body = document.createElement('div');
        body.style.fontSize = '14px';
        body.style.lineHeight = '1.5';

        const intro = document.createElement('p');
        intro.style.margin = '0 0 12px 0';
        intro.innerHTML = `<strong>${escapeHtml(project.name ?? 'This project')}</strong> was created before the template-unification update and is stored in the old project format. The current build of ParallaxPro can no longer open it.`;
        body.appendChild(intro);

        const action = document.createElement('p');
        action.style.margin = '0 0 12px 0';
        action.textContent = 'To open it, run a build of ParallaxPro from before the migration:';
        body.appendChild(action);

        const code = document.createElement('pre');
        code.style.background = 'rgba(255,255,255,0.06)';
        code.style.border = '1px solid rgba(255,255,255,0.1)';
        code.style.borderRadius = '6px';
        code.style.padding = '10px 12px';
        code.style.fontSize = '12px';
        code.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
        code.style.margin = '0 0 12px 0';
        code.style.overflowX = 'auto';
        code.textContent = `git clone https://github.com/ParallaxPro-AI/Open-ParallaxPro.git
cd Open-ParallaxPro
git checkout da571fe   # last commit before template unification`;
        body.appendChild(code);

        const link = document.createElement('p');
        link.style.margin = '0 0 12px 0';
        link.innerHTML = `Source: <a href="https://github.com/ParallaxPro-AI/Open-ParallaxPro" target="_blank" rel="noopener" style="color: #66bb6a;">github.com/ParallaxPro-AI/Open-ParallaxPro</a>`;
        body.appendChild(link);

        const tip = document.createElement('p');
        tip.style.margin = '0';
        tip.style.color = '#aaa';
        tip.style.fontSize = '12px';
        tip.textContent = 'Tip: once you reopen this project on the older build, you can recreate it on the new build to migrate.';
        body.appendChild(tip);

        const handle = showModal({
            title: 'Project requires older ParallaxPro build',
            body,
            width: '520px',
            buttons: [{ label: 'Got it', primary: true, action: () => handle.close() }],
        });
    }

    private toggleSelectAll(): void {
        if (this.selectedIds.size === this.projects.length) {
            this.selectedIds.clear();
        } else {
            for (const p of this.projects) {
                this.selectedIds.add(p.id);
            }
        }
        this.updateSelectionUI();
    }

    private toggleSelect(projectId: string): void {
        if (this.selectedIds.has(projectId)) {
            this.selectedIds.delete(projectId);
        } else {
            this.selectedIds.add(projectId);
        }
        this.updateSelectionUI();
    }

    private updateSelectionUI(): void {
        const count = this.selectedIds.size;
        const total = this.projects.length;
        this.toolbarEl.style.display = count > 0 ? 'flex' : 'none';
        this.selectCountEl.textContent = `${count} of ${total} selected`;

        const allSelected = count === total && total > 0;
        const someSelected = count > 0 && count < total;
        this.selectAllCheckbox.classList.toggle('checked', allSelected);
        this.selectAllCheckbox.classList.toggle('indeterminate', someSelected);
        this.selectAllCheckbox.innerHTML = '';
        if (allSelected) {
            this.selectAllCheckbox.appendChild(icon(Check, 12));
        } else if (someSelected) {
            const dash = document.createElement('span');
            dash.textContent = '\u2013';
            dash.style.color = '#fff';
            dash.style.fontSize = '12px';
            dash.style.lineHeight = '1';
            this.selectAllCheckbox.appendChild(dash);
        }

        const filtered = this.getFilteredProjects();
        const start = (this.currentPage - 1) * this.pageSize;
        const pageProjects = filtered.slice(start, start + this.pageSize);
        const cards = this.gridEl.querySelectorAll('.project-card');
        cards.forEach((card, idx) => {
            const checkbox = card.querySelector('.project-card-checkbox');
            if (!checkbox) return;
            if (idx >= pageProjects.length) return;
            const pid = pageProjects[idx].id;
            const isSelected = this.selectedIds.has(pid);
            card.classList.toggle('selected', isSelected);
            checkbox.classList.toggle('checked', isSelected);
            checkbox.innerHTML = '';
            if (isSelected) {
                checkbox.appendChild(icon(Check, 14));
            }
        });
    }

    private async deleteSelected(): Promise<void> {
        const count = this.selectedIds.size;
        if (count === 0) return;

        const confirmed = await showConfirmModal(
            'Delete Projects',
            `Are you sure you want to delete ${count} project${count !== 1 ? 's' : ''}? This cannot be undone.`
        );
        if (!confirmed) return;

        const idsToDelete = [...this.selectedIds];
        for (const id of idsToDelete) {
            try {
                await this.ctx.backend.deleteProject(id);
                this.projects = this.projects.filter(p => p.id !== id);
            } catch (e) {
                console.error('Failed to delete project:', id, e);
            }
        }
        this.selectedIds.clear();
        this.render();
        this.updateSelectionUI();
    }

    private showProjectMenu(project: any, x: number, y: number): void {
        const isPublished = project.status === 'published' && project.publishedSlug;
        const isSharedTab = this.activeTab === 'shared';

        const items: any[] = [
            { label: 'Open', action: () => this.onOpenProject?.(project.id) },
        ];

        if (!isSharedTab) {
            items.push({ label: 'Rename', action: () => this.renameProject(project) });
            items.push({ label: 'Duplicate', action: () => this.duplicateProject(project) });
            items.push({ label: project.thumbnail ? 'Change Thumbnail' : 'Set Thumbnail', action: () => this.setThumbnail(project) });
            if (project.thumbnail) {
                items.push({ label: 'Remove Thumbnail', action: () => this.removeThumbnail(project) });
            }
            items.push({ label: '', separator: true });

            if (isPublished) {
                items.push({
                    label: 'View Published Game',
                    action: () => {
                        window.open(`${window.location.origin}/games/${project.publishedOwner}/${project.publishedSlug}`, '_blank');
                    },
                });
                items.push({ label: 'Unpublish', action: () => this.unpublishProject(project) });
            } else {
                items.push({ label: 'Publish', action: () => this.publishProject(project) });
            }

            items.push({ label: '', separator: true });
            items.push({ label: 'Delete', danger: true, action: () => this.deleteProject(project) });
        }

        showContextMenu(x, y, items);
    }

    private getNextProjectName(): string {
        let maxNum = 0;
        for (const p of this.projects) {
            const match = (p.name ?? '').match(/^project-(\d+)$/);
            if (match) {
                maxNum = Math.max(maxNum, parseInt(match[1]));
            }
        }
        return `project-${maxNum + 1}`;
    }

    private createProject(): void {
        const body = document.createElement('div');
        body.style.display = 'flex';
        body.style.flexDirection = 'column';
        body.style.gap = '16px';

        // ── Section 1: Generate from prompt ──
        const promptSection = document.createElement('div');
        promptSection.style.display = 'flex';
        promptSection.style.flexDirection = 'column';
        promptSection.style.gap = '8px';

        const label = document.createElement('label');
        label.textContent = 'Generate from prompt';
        label.style.fontSize = '13px';
        label.style.fontWeight = '600';
        label.style.color = 'var(--text-secondary)';
        promptSection.appendChild(label);

        const promptHint = document.createElement('div');
        promptHint.textContent = 'Describe your game idea and AI will build it for you.';
        promptHint.style.fontSize = '11px';
        promptHint.style.color = 'var(--text-tertiary, #888)';
        promptSection.appendChild(promptHint);

        const textarea = document.createElement('textarea');
        textarea.placeholder = 'e.g. A 3D platformer with double-jump and coin collection...';
        textarea.maxLength = 2000;
        textarea.style.width = '100%';
        textarea.style.height = '100px';
        textarea.style.resize = 'vertical';
        textarea.style.fontSize = '13px';
        textarea.style.lineHeight = '1.5';
        textarea.style.padding = '8px 10px';
        textarea.style.background = 'var(--bg-input)';
        textarea.style.border = '1px solid var(--border)';
        textarea.style.borderRadius = 'var(--radius-sm)';
        textarea.style.color = 'var(--text-primary)';
        textarea.style.fontFamily = 'var(--font-family)';
        promptSection.appendChild(textarea);

        body.appendChild(promptSection);

        // ── Divider with "or" ──
        const divider = document.createElement('div');
        divider.style.display = 'flex';
        divider.style.alignItems = 'center';
        divider.style.gap = '12px';
        const divLine1 = document.createElement('div');
        divLine1.style.flex = '1';
        divLine1.style.height = '1px';
        divLine1.style.background = 'var(--border)';
        const divText = document.createElement('span');
        divText.textContent = 'or';
        divText.style.fontSize = '12px';
        divText.style.color = 'var(--text-tertiary, #888)';
        divText.style.flexShrink = '0';
        const divLine2 = document.createElement('div');
        divLine2.style.flex = '1';
        divLine2.style.height = '1px';
        divLine2.style.background = 'var(--border)';
        divider.appendChild(divLine1);
        divider.appendChild(divText);
        divider.appendChild(divLine2);
        body.appendChild(divider);

        // ── Section 2: Build from template ──
        const templateSection = document.createElement('div');
        templateSection.style.display = 'flex';
        templateSection.style.flexDirection = 'column';
        templateSection.style.gap = '8px';

        const templateLabel = document.createElement('label');
        templateLabel.textContent = 'Build from template';
        templateLabel.style.fontSize = '13px';
        templateLabel.style.fontWeight = '600';
        templateLabel.style.color = 'var(--text-secondary)';
        templateSection.appendChild(templateLabel);

        const templateHint = document.createElement('div');
        templateHint.textContent = 'Start with a ready-made game template you can customize.';
        templateHint.style.fontSize = '11px';
        templateHint.style.color = 'var(--text-tertiary, #888)';
        templateSection.appendChild(templateHint);

        // Search input
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = 'Search templates...';
        searchInput.style.width = '100%';
        searchInput.style.fontSize = '13px';
        searchInput.style.padding = '7px 10px';
        searchInput.style.background = 'var(--bg-input)';
        searchInput.style.border = '1px solid var(--border)';
        searchInput.style.borderRadius = 'var(--radius-sm)';
        searchInput.style.color = 'var(--text-primary)';
        searchInput.style.fontFamily = 'var(--font-family)';
        templateSection.appendChild(searchInput);

        // Template list container
        const templateList = document.createElement('div');
        templateList.style.maxHeight = '180px';
        templateList.style.overflowY = 'auto';
        templateList.style.display = 'flex';
        templateList.style.flexDirection = 'column';
        templateList.style.gap = '4px';
        templateList.style.border = '1px solid var(--border)';
        templateList.style.borderRadius = 'var(--radius-sm)';
        templateList.style.padding = '4px';
        templateList.style.background = 'var(--bg-input)';
        templateSection.appendChild(templateList);

        let allTemplates: any[] = [];
        let selectedTemplateId = '';

        const renderTemplateList = (filter: string) => {
            templateList.innerHTML = '';
            const query = filter.toLowerCase();
            const filtered = allTemplates.filter(t =>
                !query || t.name.toLowerCase().includes(query) || t.id.toLowerCase().includes(query) || (t.description || '').toLowerCase().includes(query)
            );
            if (filtered.length === 0) {
                const empty = document.createElement('div');
                empty.textContent = query ? 'No templates match your search' : 'Loading...';
                empty.style.fontSize = '12px';
                empty.style.color = 'var(--text-tertiary, #888)';
                empty.style.padding = '8px';
                empty.style.textAlign = 'center';
                templateList.appendChild(empty);
                return;
            }
            for (const t of filtered) {
                const item = document.createElement('div');
                item.style.display = 'flex';
                item.style.alignItems = 'center';
                item.style.justifyContent = 'space-between';
                item.style.padding = '6px 8px';
                item.style.borderRadius = '4px';
                item.style.cursor = 'pointer';
                item.style.fontSize = '12px';
                item.style.transition = 'background 0.1s';
                item.style.background = t.id === selectedTemplateId ? 'var(--accent-bg, rgba(59,130,246,0.15))' : 'transparent';
                item.style.border = t.id === selectedTemplateId ? '1px solid var(--accent, #3b82f6)' : '1px solid transparent';

                const info = document.createElement('div');
                const nameEl = document.createElement('div');
                nameEl.style.fontWeight = '600';
                nameEl.style.color = 'var(--text-primary)';
                nameEl.textContent = t.name;
                const descEl = document.createElement('div');
                descEl.style.fontSize = '11px';
                descEl.style.color = 'var(--text-tertiary, #888)';
                descEl.style.marginTop = '1px';
                descEl.textContent = `${t.description} · ${t.entityCount} entities`;
                info.appendChild(nameEl);
                info.appendChild(descEl);
                item.appendChild(info);

                item.addEventListener('mouseenter', () => { if (t.id !== selectedTemplateId) item.style.background = 'var(--bg-hover, rgba(255,255,255,0.04))'; });
                item.addEventListener('mouseleave', () => { if (t.id !== selectedTemplateId) item.style.background = 'transparent'; });
                item.addEventListener('click', () => {
                    selectedTemplateId = selectedTemplateId === t.id ? '' : t.id;
                    renderTemplateList(searchInput.value);
                    // Mutual exclusion
                    textarea.disabled = !!selectedTemplateId;
                    textarea.style.opacity = selectedTemplateId ? '0.4' : '1';
                });
                templateList.appendChild(item);
            }
        };

        // Load templates from backend
        this.ctx.backend.listTemplates().then((data: any) => {
            allTemplates = data?.templates || [];
            renderTemplateList('');
        }).catch(() => {});

        // Search: instant client-side filter + debounced semantic search
        let searchTimer: any = null;
        searchInput.addEventListener('input', () => {
            // Instant client-side filter
            renderTemplateList(searchInput.value);

            // Debounced semantic search from backend
            if (searchTimer) clearTimeout(searchTimer);
            const query = searchInput.value.trim();
            if (query.length >= 2) {
                searchTimer = setTimeout(() => {
                    this.ctx.backend.listTemplates(query).then((data: any) => {
                        if (searchInput.value.trim() === query) {
                            allTemplates = data?.templates || allTemplates;
                            renderTemplateList(query);
                        }
                    }).catch(() => {});
                }, 300);
            }
        });

        body.appendChild(templateSection);

        // ── Mutual exclusion ──
        textarea.addEventListener('input', () => {
            const hasPrompt = textarea.value.trim().length > 0;
            if (hasPrompt) {
                selectedTemplateId = '';
                renderTemplateList(searchInput.value);
            }
            searchInput.disabled = hasPrompt;
            searchInput.style.opacity = hasPrompt ? '0.4' : '1';
            templateList.style.opacity = hasPrompt ? '0.4' : '1';
            templateList.style.pointerEvents = hasPrompt ? 'none' : 'auto';
        });

        // ── Submit handlers ──
        const submitPrompt = async (prompt: string) => {
            const name = this.getNextProjectName();
            try {
                const project = await this.ctx.backend.createProject(undefined, prompt);
                const pid = project.projectId ?? project.id;
                this.projects.unshift({ id: pid, name: project.name ?? name, prompt, ...project });
                this.render();
                this.onOpenProject?.(pid, prompt);
            } catch (e) {
                console.error('Failed to create project:', e);
            }
        };

        const submitTemplate = async (templateId: string) => {
            const name = this.getNextProjectName();
            try {
                const project = await this.ctx.backend.createProject(undefined, undefined, templateId);
                const pid = project.projectId ?? project.id;
                this.projects.unshift({ id: pid, name: project.name ?? name, ...project });
                this.render();
                this.onOpenProject?.(pid);
            } catch (e) {
                console.error('Failed to create project from template:', e);
            }
        };

        const { close } = showModal({
            title: 'New Project',
            body,
            width: '520px',
            buttons: [
                { label: 'Cancel', action: () => close() },
                {
                    label: 'Generate',
                    primary: true,
                    action: async () => {
                        if (selectedTemplateId) {
                            close();
                            await submitTemplate(selectedTemplateId);
                            return;
                        }
                        const prompt = textarea.value.trim();
                        if (!prompt) return;
                        close();
                        await submitPrompt(prompt);
                    },
                },
            ],
        });

        textarea.focus();

        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                const prompt = textarea.value.trim();
                if (!prompt) return;
                close();
                submitPrompt(prompt);
            }
        });
    }

    private async renameProject(project: any): Promise<void> {
        const newName = await showPromptModal('Rename Project', project.name, 'New name');
        if (!newName) return;
        try {
            await this.ctx.backend.renameProject(project.id, newName);
            project.name = newName;
            this.render();
        } catch (e) {
            console.error('Failed to rename project:', e);
        }
    }

    private async duplicateProject(project: any): Promise<void> {
        try {
            const newProject = await this.ctx.backend.duplicateProject(project.id);
            this.projects.unshift(newProject);
            this.render();
        } catch (e) {
            console.error('Failed to duplicate project:', e);
        }
    }

    private async deleteProject(project: any): Promise<void> {
        const confirmed = await showConfirmModal(
            'Delete Project',
            `Are you sure you want to delete "${project.name}"? This cannot be undone.`
        );
        if (!confirmed) return;
        try {
            await this.ctx.backend.deleteProject(project.id);
            this.projects = this.projects.filter(p => p.id !== project.id);
            this.selectedIds.delete(project.id);
            this.render();
            this.updateSelectionUI();
        } catch (e) {
            console.error('Failed to delete project:', e);
        }
    }

    private isHosted(): boolean {
        const h = window.location.hostname;
        return h === 'parallaxpro.ai' || h === 'www.parallaxpro.ai';
    }

    private showSelfHostedPublishMessage(): void {
        const body = document.createElement('div');
        body.style.cssText = 'display:flex;flex-direction:column;gap:12px;';
        const msg = document.createElement('div');
        msg.style.cssText = 'font-size:13px;line-height:1.6;color:var(--text-primary);';
        msg.innerHTML = `Publishing is currently only available on the hosted version at <a href="https://parallaxpro.ai/editor" target="_blank" style="color:var(--accent);">parallaxpro.ai</a>.<br><br>We're working on a way to publish directly from self-hosted instances. Stay tuned!`;
        body.appendChild(msg);
        const { close } = showModal({
            title: 'Publish',
            body,
            width: '400px',
            buttons: [{ label: 'OK', primary: true, action: () => close() }],
        });
    }

    private async publishProject(project: any): Promise<void> {
        if (!this.isHosted()) { this.showSelfHostedPublishMessage(); return; }

        const body = document.createElement('div');
        body.style.cssText = 'display:flex;flex-direction:column;gap:12px;';

        const mkLabel = (text: string) => {
            const lbl = document.createElement('label');
            lbl.textContent = text;
            lbl.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-secondary);';
            return lbl;
        };
        const mkInput = (value: string, placeholder: string) => {
            const inp = document.createElement('input');
            inp.type = 'text'; inp.value = value; inp.placeholder = placeholder;
            inp.style.cssText = 'width:100%;height:32px;padding:0 10px;font-size:13px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);';
            return inp;
        };

        body.appendChild(mkLabel('Game Name'));
        const nameInput = mkInput(project.name ?? '', 'My Awesome Game');
        body.appendChild(nameInput);

        body.appendChild(mkLabel('URL Slug'));
        const slugInput = mkInput(
            (project.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'my-game',
            'my-game-name'
        );
        body.appendChild(slugInput);

        const preview = document.createElement('div');
        preview.style.cssText = 'font-size:12px;color:var(--text-disabled);word-break:break-all;';
        const updatePreview = () => { preview.textContent = `${window.location.origin}/games/you/${slugInput.value || 'my-game'}`; };
        updatePreview();
        slugInput.addEventListener('input', updatePreview);
        body.appendChild(preview);

        body.appendChild(mkLabel('Version'));
        const versionInput = mkInput('1.0.0', '1.0.0');
        body.appendChild(versionInput);

        body.appendChild(mkLabel('Changelog (optional)'));
        const changelogInput = document.createElement('textarea');
        changelogInput.placeholder = 'What\'s in this version...';
        changelogInput.style.cssText = 'width:100%;height:50px;resize:vertical;font-family:inherit;font-size:13px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);padding:6px 10px;';
        body.appendChild(changelogInput);

        const errorMsg = document.createElement('div');
        errorMsg.style.cssText = 'color:#e74c3c;font-size:12px;display:none;';
        body.appendChild(errorMsg);

        const { close } = showModal({
            title: 'Publish Game',
            body,
            width: '420px',
            closeOnBackdrop: false,
            buttons: [
                { label: 'Cancel', action: () => close() },
                {
                    label: 'Publish',
                    primary: true,
                    action: async () => {
                        const gameName = nameInput.value.trim();
                        const slug = slugInput.value.trim();
                        const version = versionInput.value.trim();
                        if (!gameName || !slug) { errorMsg.textContent = 'Name and slug are required.'; errorMsg.style.display = 'block'; return; }
                        if (!version) { errorMsg.textContent = 'Version is required.'; errorMsg.style.display = 'block'; return; }
                        try {
                            const result = await this.ctx.backend.publishProject(project.id, gameName, slug, 'public', version, changelogInput.value.trim());
                            close();
                            project.status = 'published';
                            project.publishedSlug = result.slug;
                            project.publishedOwner = result.owner;
                            project.publishedVersion = result.version;
                            this.render();
                        } catch (e: any) {
                            errorMsg.textContent = e.message?.replace(/^API error \d+: /, '') || 'Publish failed.';
                            try { errorMsg.textContent = JSON.parse(e.message?.replace(/^API error \d+: /, '') || '{}').error || errorMsg.textContent; } catch {}
                            errorMsg.style.display = 'block';
                        }
                    },
                },
            ],
        });

        nameInput.focus();
    }

    private setThumbnail(project: any): void {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/png,image/jpeg,image/webp,image/gif';
        fileInput.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            if (!file) return;
            try {
                const result = await this.ctx.backend.uploadThumbnail(project.id, file);
                project.thumbnail = result.thumbnail;
                this.render();
            } catch (e) {
                console.error('Failed to upload thumbnail:', e);
            }
        });
        fileInput.click();
    }

    private async removeThumbnail(project: any): Promise<void> {
        try {
            await this.ctx.backend.deleteThumbnail(project.id);
            project.thumbnail = null;
            this.render();
        } catch (e) {
            console.error('Failed to remove thumbnail:', e);
        }
    }

    private async unpublishProject(project: any): Promise<void> {
        const confirmed = await showConfirmModal(
            'Unpublish Game',
            `This will take "${project.name}" offline. Players will no longer be able to access the published version.`
        );
        if (!confirmed) return;
        try {
            await this.ctx.backend.unpublishProject(project.id);
            project.status = 'draft';
            project.publishedSlug = null;
            project.publishedOwner = null;
            this.render();
        } catch (e) {
            console.error('Failed to unpublish:', e);
        }
    }
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]!));
}
