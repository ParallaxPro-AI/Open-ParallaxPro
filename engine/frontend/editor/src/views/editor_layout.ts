export class EditorLayout {
    readonly el: HTMLElement;

    readonly leftColumn: HTMLElement;
    readonly centerColumn: HTMLElement;
    readonly rightColumn: HTMLElement;

    readonly leftTop: HTMLElement;
    readonly leftBottom: HTMLElement;

    readonly centerTop: HTMLElement;
    readonly centerBottom: HTMLElement;

    constructor() {
        this.el = document.createElement('div');
        this.el.className = 'editor-body';

        this.leftColumn = document.createElement('div');
        this.leftColumn.className = 'editor-column left';

        this.leftTop = document.createElement('div');
        this.leftTop.style.flex = '1';
        this.leftTop.style.display = 'flex';
        this.leftTop.style.flexDirection = 'column';
        this.leftTop.style.overflow = 'hidden';
        this.leftTop.style.minHeight = '100px';
        this.leftColumn.appendChild(this.leftTop);

        const leftRowResizer = this.createRowResizer(this.leftTop, this.leftColumn);
        this.leftColumn.appendChild(leftRowResizer);

        this.leftBottom = document.createElement('div');
        this.leftBottom.style.flex = '1';
        this.leftBottom.style.display = 'flex';
        this.leftBottom.style.flexDirection = 'column';
        this.leftBottom.style.overflow = 'hidden';
        this.leftBottom.style.minHeight = '100px';
        this.leftColumn.appendChild(this.leftBottom);

        this.el.appendChild(this.leftColumn);

        const leftResizer = this.createColumnResizer(this.leftColumn);
        this.el.appendChild(leftResizer);

        this.centerColumn = document.createElement('div');
        this.centerColumn.className = 'editor-column center';

        this.centerTop = document.createElement('div');
        this.centerTop.style.flex = '1';
        this.centerTop.style.display = 'flex';
        this.centerTop.style.flexDirection = 'column';
        this.centerTop.style.overflow = 'hidden';
        this.centerTop.style.minHeight = '200px';
        this.centerColumn.appendChild(this.centerTop);

        const centerRowResizer = this.createRowResizer(this.centerTop, this.centerColumn);
        this.centerColumn.appendChild(centerRowResizer);

        this.centerBottom = document.createElement('div');
        this.centerBottom.style.flex = '1';
        this.centerBottom.style.minHeight = '100px';
        this.centerBottom.style.display = 'flex';
        this.centerBottom.style.flexDirection = 'column';
        this.centerBottom.style.overflow = 'hidden';
        this.centerColumn.appendChild(this.centerBottom);

        this.el.appendChild(this.centerColumn);

        const rightResizer = this.createColumnResizer(this.rightColumn = document.createElement('div'));
        this.el.appendChild(rightResizer);

        this.rightColumn.className = 'editor-column right';
        this.rightColumn.style.display = 'flex';
        this.rightColumn.style.flexDirection = 'column';
        this.el.appendChild(this.rightColumn);
    }

    private createColumnResizer(targetColumn: HTMLElement): HTMLElement {
        const resizer = document.createElement('div');
        resizer.className = 'column-resizer';

        let startX = 0;
        let startWidth = 0;
        let isLeft = false;

        const onMouseDown = (e: MouseEvent) => {
            e.preventDefault();
            startX = e.clientX;
            startWidth = targetColumn.getBoundingClientRect().width;
            isLeft = targetColumn.classList.contains('left');
            resizer.classList.add('active');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
        };

        const onMouseMove = (e: MouseEvent) => {
            const dx = e.clientX - startX;
            const newWidth = isLeft ? startWidth + dx : startWidth - dx;
            const clamped = Math.max(180, Math.min(600, newWidth));
            targetColumn.style.width = `${clamped}px`;
        };

        const onMouseUp = () => {
            resizer.classList.remove('active');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };

        resizer.addEventListener('mousedown', onMouseDown);
        return resizer;
    }

    private createRowResizer(topElement: HTMLElement, container: HTMLElement): HTMLElement {
        const resizer = document.createElement('div');
        resizer.className = 'row-resizer';

        let startY = 0;
        let startHeight = 0;

        const onMouseDown = (e: MouseEvent) => {
            e.preventDefault();
            startY = e.clientY;
            startHeight = topElement.getBoundingClientRect().height;
            resizer.classList.add('active');
            document.body.style.cursor = 'row-resize';
            document.body.style.userSelect = 'none';
            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
        };

        const onMouseMove = (e: MouseEvent) => {
            const dy = e.clientY - startY;
            const containerHeight = container.getBoundingClientRect().height;
            const newHeight = startHeight + dy;
            const clamped = Math.max(100, Math.min(containerHeight - 120, newHeight));
            topElement.style.flex = 'none';
            topElement.style.height = `${clamped}px`;
        };

        const onMouseUp = () => {
            resizer.classList.remove('active');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };

        resizer.addEventListener('mousedown', onMouseDown);
        return resizer;
    }
}
