export interface TreeNode {
    id: string | number;
    label: string;
    icon?: string;
    children?: TreeNode[];
    data?: any;
}

export interface TreeWidgetOptions {
    onSelect?: (node: TreeNode) => void;
    onDoubleClick?: (node: TreeNode) => void;
    onContextMenu?: (node: TreeNode, x: number, y: number) => void;
    onDragDrop?: (sourceId: string | number, targetId: string | number, position: 'above' | 'below' | 'inside') => void;
    multiSelect?: boolean;
}

/**
 * Generic tree widget that renders a collapsible tree of nodes.
 * Used for scene hierarchy and file trees.
 */
export class TreeWidget {
    readonly el: HTMLElement;
    private nodes: TreeNode[] = [];
    private options: TreeWidgetOptions;
    private selectedIds: Set<string | number> = new Set();
    private collapsedIds: Set<string | number> = new Set();
    private dragSourceId: string | number | null = null;

    constructor(options: TreeWidgetOptions = {}) {
        this.options = options;
        this.el = document.createElement('div');
        this.el.className = 'tree-widget';
        this.el.style.overflow = 'auto';
        this.el.style.flex = '1';
    }

    setNodes(nodes: TreeNode[]): void {
        this.nodes = nodes;
        this.render();
    }

    setSelectedIds(ids: Set<string | number>): void {
        this.selectedIds = ids;
        this.updateSelectionVisuals();
    }

    getCollapsedIds(): Set<string | number> {
        return this.collapsedIds;
    }

    setCollapsedIds(ids: Set<string | number>): void {
        this.collapsedIds = ids;
        this.render();
    }

    render(): void {
        this.el.innerHTML = '';
        this.renderNodes(this.nodes, 0, this.el);
    }

    private renderNodes(nodes: TreeNode[], depth: number, container: HTMLElement): void {
        for (const node of nodes) {
            const hasChildren = node.children && node.children.length > 0;
            const isCollapsed = this.collapsedIds.has(node.id);
            const isSelected = this.selectedIds.has(node.id);

            const row = document.createElement('div');
            row.className = 'tree-node';
            if (isSelected) row.classList.add('selected');
            row.dataset.nodeId = String(node.id);
            row.draggable = true;

            // Indentation
            for (let i = 0; i < depth; i++) {
                const indent = document.createElement('span');
                indent.className = 'tree-node-indent';
                row.appendChild(indent);
            }

            // Expand/collapse arrow
            const expand = document.createElement('span');
            expand.className = 'tree-node-expand';
            if (hasChildren) {
                expand.textContent = '\u25BC';
                if (isCollapsed) expand.classList.add('collapsed');
                expand.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (this.collapsedIds.has(node.id)) {
                        this.collapsedIds.delete(node.id);
                    } else {
                        this.collapsedIds.add(node.id);
                    }
                    this.render();
                });
            }
            row.appendChild(expand);

            // Icon
            if (node.icon) {
                const iconEl = document.createElement('span');
                iconEl.className = 'tree-node-icon';
                iconEl.textContent = node.icon;
                row.appendChild(iconEl);
            }

            // Label
            const name = document.createElement('span');
            name.className = 'tree-node-name';
            name.textContent = node.label;
            row.appendChild(name);

            row.addEventListener('click', (e) => {
                e.stopPropagation();
                this.options.onSelect?.(node);
            });

            row.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                this.options.onDoubleClick?.(node);
            });

            row.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.options.onContextMenu?.(node, e.clientX, e.clientY);
            });

            // Drag & drop
            row.addEventListener('dragstart', (e) => {
                this.dragSourceId = node.id;
                if (e.dataTransfer) {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', String(node.id));
                }
            });

            row.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (this.dragSourceId === node.id) return;
                row.classList.remove('drag-over-above', 'drag-over-below', 'drag-over-inside');

                const rect = row.getBoundingClientRect();
                const y = e.clientY - rect.top;
                const third = rect.height / 3;

                if (y < third) {
                    row.classList.add('drag-over-above');
                } else if (y > rect.height - third) {
                    row.classList.add('drag-over-below');
                } else {
                    row.classList.add('drag-over-inside');
                }
            });

            row.addEventListener('dragleave', () => {
                row.classList.remove('drag-over-above', 'drag-over-below', 'drag-over-inside');
            });

            row.addEventListener('drop', (e) => {
                e.preventDefault();
                row.classList.remove('drag-over-above', 'drag-over-below', 'drag-over-inside');

                if (this.dragSourceId === null || this.dragSourceId === node.id) return;

                const rect = row.getBoundingClientRect();
                const y = e.clientY - rect.top;
                const third = rect.height / 3;

                let position: 'above' | 'below' | 'inside';
                if (y < third) {
                    position = 'above';
                } else if (y > rect.height - third) {
                    position = 'below';
                } else {
                    position = 'inside';
                }

                this.options.onDragDrop?.(this.dragSourceId, node.id, position);
                this.dragSourceId = null;
            });

            row.addEventListener('dragend', () => {
                this.dragSourceId = null;
                const allNodes = this.el.querySelectorAll('.tree-node');
                allNodes.forEach(n => n.classList.remove('drag-over-above', 'drag-over-below', 'drag-over-inside'));
            });

            container.appendChild(row);

            if (hasChildren && !isCollapsed) {
                this.renderNodes(node.children!, depth + 1, container);
            }
        }
    }

    private updateSelectionVisuals(): void {
        const allRows = this.el.querySelectorAll('.tree-node');
        allRows.forEach(row => {
            const id = (row as HTMLElement).dataset.nodeId;
            if (id !== undefined) {
                const numId = Number(id);
                const selected = this.selectedIds.has(id) || this.selectedIds.has(numId);
                row.classList.toggle('selected', selected);
            }
        });
    }
}
