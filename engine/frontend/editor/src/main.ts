if ((window as any).__mobileBlocked) throw new Error('Mobile blocked');

import './utils/error_tracker.js';
import { checkForUpdates } from './utils/version_check.js';

import './styles/theme.css';
import './styles/editor.css';
import './styles/toolbar.css';
import './styles/panels.css';
import './styles/hierarchy.css';
import './styles/properties.css';
import './styles/viewport.css';
import './styles/assets.css';
import './styles/chat.css';
import './styles/widgets.css';
import './styles/fields.css';
import './styles/project-list.css';

import { EditorContext } from './editor_context.js';
import { ProjectListView } from './views/project_list_view.js';
import { EditorView } from './views/editor_view.js';

export function redirectToLogin(): void {
    window.location.href = window.location.origin + '/login';
}

class App {
    private appRoot: HTMLElement;
    private currentView: { el: HTMLElement; destroy?: () => void } | null = null;

    constructor() {
        this.appRoot = document.getElementById('app')!;
        if (!this.appRoot) {
            throw new Error('Cannot find #app element');
        }
    }

    async start(): Promise<void> {
        const params = new URLSearchParams(window.location.search);

        const urlToken = params.get('token');
        if (urlToken) {
            localStorage.setItem('auth_token', urlToken);
            params.delete('token');
            const cleanUrl = params.toString()
                ? `${window.location.pathname}?${params.toString()}`
                : window.location.pathname;
            window.history.replaceState({}, '', cleanUrl);
        }

        const token = localStorage.getItem('auth_token') ?? localStorage.getItem('token');
        const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

        const roomCode = params.get('room');
        if (roomCode && !params.get('project')) {
            window.location.href = `/play/multiplayer?room=${roomCode}`;
            return;
        }

        if (!token && !isDev) {
            redirectToLogin();
            return;
        }

        const projectId = params.get('project');

        if (projectId) {
            await this.showEditor(projectId);
        } else {
            this.showProjectList();
        }
    }

    private showProjectList(): void {
        this.clearView();

        const view = new ProjectListView();
        view.onOpen((projectId: string, initialPrompt?: string) => {
            const url = new URL(window.location.href);
            url.searchParams.set('project', projectId);
            window.history.pushState({}, '', url.toString());
            this.showEditor(projectId, initialPrompt);
        });

        this.appRoot.appendChild(view.el);
        this.currentView = { el: view.el };
    }

    private async showEditor(projectId: string, initialPrompt?: string): Promise<void> {
        this.clearView();

        const view = new EditorView();
        this.appRoot.appendChild(view.el);

        try {
            await view.initialize(projectId);
            // Check for pending prompt from landing page or project creation
            const prompt = initialPrompt || localStorage.getItem('pendingPrompt');
            if (prompt) {
                localStorage.removeItem('pendingPrompt');
                view.sendInitialChatMessage(prompt);
            }

            // ?auto_play=1 is used by the "+ Preview Client" toolbar button so
            // a second tab of the editor starts playing as soon as the project
            // loads. The mp_bridge auto-connects to the lobby server; the dev
            // just clicks Join on one side and Host on the other.
            //
            // Consume the flag from the URL immediately so navigating to a
            // different project from within the editor doesn't auto-play it.
            const urlParams = new URLSearchParams(window.location.search);
            const autoPlay = urlParams.get('auto_play');
            if (autoPlay === '1') {
                urlParams.delete('auto_play');
                const cleanUrl = urlParams.toString()
                    ? `${window.location.pathname}?${urlParams.toString()}`
                    : window.location.pathname;
                window.history.replaceState({}, '', cleanUrl);

                const ctx = EditorContext.instance;
                // Give the asset loader a beat to start, then kick play.
                setTimeout(() => { try { ctx.play(); } catch { /* ignored */ } }, 400);
            }
        } catch (e) {
            console.error('Failed to initialize editor:', e);
        }

        (window as any).__editorContext = EditorContext.instance;

        this.currentView = {
            el: view.el,
            destroy: () => view.destroy(),
        };
    }

    private clearView(): void {
        if (this.currentView) {
            this.currentView.destroy?.();
            this.currentView.el.remove();
            this.currentView = null;
        }
    }
}

if (document.getElementById('app')) {
    window.addEventListener('popstate', () => {
        window.location.reload();
    });

    checkForUpdates();

    const app = new App();
    app.start().catch(e => {
        console.error('Failed to start ParallaxPro Editor:', e);
        const appEl = document.getElementById('app');
        if (appEl) {
            appEl.innerHTML = `
                <div style="display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:16px;color:#e0e0e0;font-family:sans-serif;">
                    <div style="font-size:48px;">&#x26A0;</div>
                    <div style="font-size:18px;font-weight:600;">Failed to start the editor</div>
                    <div style="color:#999;font-size:14px;">${e.message || 'Unknown error'}</div>
                    <button onclick="window.location.reload()" style="padding:8px 24px;background:#69bbf3;color:#1e1e1e;border:none;border-radius:5px;cursor:pointer;font-weight:600;">Reload</button>
                </div>
            `;
        }
    });
}
