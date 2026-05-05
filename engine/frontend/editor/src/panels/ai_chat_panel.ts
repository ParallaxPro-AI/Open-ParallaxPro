import { EditorContext } from '../editor_context.js';
import { icon, ThumbsUp, ThumbsDown, RefreshCw, X } from '../widgets/icons.js';
import { showModal } from '../widgets/modal.js';
import { t } from '../i18n/index.js';

interface ChatMessage {
    id?: number;
    role: 'user' | 'assistant';
    content: string;
    fileChanges?: FileChange[];
    feedback?: string | null;
    // Present when the LLM's OFFER_CREATE_GAME tool ran on this message.
    // Persisted on the chat_message row so the "Create from scratch"
    // button re-renders from chat history on refresh, instead of
    // relying on an ephemeral WS event that only fires live.
    offerCreateGameDescription?: string | null;
}

/**
 * Asset chip — a 3D model the user "added to chat" from ModelGenPanel.
 *
 * The user sees the chip (thumb + label, never a path); the AI sees the
 * path inlined into the message body via formatChipsForAI(). Persisted
 * inside the message text using a parseable prefix block, so chat
 * history re-renders correctly after refresh without a schema change.
 */
interface AssetAttachment {
    /** generated_models.id — 32-hex token. */
    id: string;
    /** /assets/generated/aa/bb/<id>.glb — what gets passed to the AI. */
    path: string;
    /** Derived thumbnail URL — same dir, .thumb.webp suffix. */
    thumbUrl: string;
    /** Original generation prompt. Doubles as the chip's label. */
    prompt: string;
    upAxis?: string;
    forwardAxis?: string;
    estScaleM?: number | null;
    bbox?: any;
}

interface FileChange {
    path: string;
    // 'template_load' is a destructive full-tree replace (LOAD_TEMPLATE);
    // the chat panel surfaces a prominent restore banner for it.
    type: 'created' | 'modified' | 'deleted' | 'template_load';
}

interface ChatSession {
    id: string;
    preview: string;
    createdAt: string;
    active: boolean;
}

/** One option in the agent picker. Backend sends id/label/caption on connect. */
interface AgentOption {
    id: string;
    label: string;
    caption: string;
}

const AUTO_AGENT_CAPTION = 'For chatting, small scene edits, and tool calls. Auto-dispatches the Editing Agent when a task gets too complex.';

/** Option always available regardless of which CLIs the backend host has. */
const BUILTIN_AGENT_OPTIONS: AgentOption[] = [
    { id: 'auto', label: 'Auto', caption: AUTO_AGENT_CAPTION },
];

const CLI_AGENT_CAPTION = 'Edits your project files based on your prompt. Not for chatting.';

const enum State {
    IDLE,
    STREAMING,
}

/** Marker tags wrapping the attached-assets block in a user message.
 *  Stable strings so renderMessageEl can strip them on chat-history
 *  re-render and surface chip cards in their place. */
const ATTACH_OPEN = '[Attached 3D models — strongly prefer these over searching]';
const ATTACH_CLOSE = '[/Attached 3D models]';
/** Per-line format inside the block. AI parses this verbatim; renderer
 *  parses the same regex below to rebuild chips. */
const ATTACH_LINE_RE = /^- "([^"]+)" — path: (\/assets\/generated\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{32}\.glb)\b/;

/** Build the attachment-block prefix that gets prepended to the user's
 *  text on send. AI sees this; user-visible message strips it back to
 *  chips at render time. */
function formatChipsForAI(chips: AssetAttachment[]): string {
    if (chips.length === 0) return '';
    const lines = chips.map(c => {
        let line = `- "${c.prompt.replace(/"/g, '\\"')}" — path: ${c.path}`;
        if (c.estScaleM != null) line += ` (est_scale_m=${c.estScaleM})`;
        return line;
    });
    return `${ATTACH_OPEN}\n${lines.join('\n')}\n${ATTACH_CLOSE}\n\n`;
}

/** Inverse of formatChipsForAI — extracts chips from a stored message
 *  for re-render on chat history reload. Returns the chips parsed plus
 *  the user-facing text with the block stripped. Tolerant of malformed
 *  blocks (returns no chips, leaves text intact). */
function parseChipsFromContent(content: string): { chips: AssetAttachment[]; cleanText: string } {
    const open = content.indexOf(ATTACH_OPEN);
    if (open !== 0) return { chips: [], cleanText: content };
    const close = content.indexOf(ATTACH_CLOSE, open);
    if (close < 0) return { chips: [], cleanText: content };

    const block = content.slice(open + ATTACH_OPEN.length, close).trim();
    const chips: AssetAttachment[] = [];
    for (const line of block.split('\n')) {
        const m = line.match(ATTACH_LINE_RE);
        if (!m) continue;
        const path = m[2];
        chips.push({
            id: path.replace(/^.*\//, '').replace(/\.glb$/, ''),
            path,
            thumbUrl: path.replace(/\.glb$/, '.thumb.webp'),
            prompt: m[1].replace(/\\"/g, '"'),
        });
    }
    // Strip the block + the trailing blank line(s).
    const after = content.slice(close + ATTACH_CLOSE.length).replace(/^\s*\n+/, '');
    return { chips, cleanText: after };
}

export class AiChatPanel {
    readonly el: HTMLElement;

    private readonly ctx: EditorContext;
    private readonly messagesContainer: HTMLElement;
    private readonly textarea: HTMLTextAreaElement;
    private readonly sendBtn: HTMLButtonElement;
    /** Public so a wrapper (e.g. EditorView's ai-panel tabs) can hoist
     *  this button into its own panel-header when constructed with
     *  `headlessHeader: true`. */
    readonly sessionBtn: HTMLButtonElement;
    private readonly sessionIdLabel: HTMLElement;

    private messages: ChatMessage[] = [];
    private state: State = State.IDLE;
    private currentSessionId: string = '';
    private emptyState: HTMLElement | null = null;
    private typingIndicator: HTMLElement | null = null;
    // Feedback form overlay — when the backend fires `feedback_required`
    // after a completed CREATE_GAME / FIX_GAME, the chat UI is replaced
    // with this form until the user rates the run. See showFeedbackForm().
    private feedbackForm: HTMLElement | null = null;
    private pendingFeedbackContent: string | null = null;
    private feedbackChatEls: HTMLElement[] = [];
    private sessionMenu: HTMLElement | null = null;
    private todoPanel: HTMLElement | null = null;
    private todoItems: HTMLElement[] = [];
    private todoTexts: string[] = [];
    private isTodoDriving: boolean = false;
    private pendingChunks: string = '';
    private rawFilesOverlay: HTMLElement | null = null;
    private rawFilesContainer: HTMLElement | null = null;
    private rawFilesRefreshTimer: number = 0;

    /** "Use in chat" attachments staged for the next sendMessage().
     *  Cleared on send. Persisted in sessionStorage so a refresh
     *  mid-compose doesn't lose them. */
    private chips: AssetAttachment[] = [];
    private chipsContainer: HTMLElement | null = null;
    /** sessionStorage key — scoped per project so two open tabs on
     *  different projects don't share staged chips. Resolved lazily
     *  because ctx.state.projectId may not be set at constructor time. */
    private chipsStorageKey(): string {
        const pid = (this.ctx as any)?.state?.projectId ?? 'default';
        return `parallax:chat-chips:${pid}`;
    }

    // Agent picker — populated from the `connected` WS event. Starts empty;
    // once the backend responds with availableAgents we fill in claude/codex
    // entries in addition to the built-in Auto / Small LLM options.
    private availableCLIAgents: AgentOption[] = [];
    private selectedAgent: string = 'auto';
    private agentSelect: HTMLSelectElement | null = null;
    private agentCaption: HTMLElement | null = null;
    // Live indicator showing which CLI will run the next FIX_GAME / CREATE_GAME
    // (separate from the chat-agent picker, since the chat agent decides
    // *whether* to call those tools, but the editing agent decides which CLI
    // does the actual work). Only rendered when 2+ CLI agents are installed.
    // Stays in sync via a custom event dispatched from the Settings dropdown.
    private editingAgentBadge: HTMLElement | null = null;
    private regenMenu: HTMLElement | null = null;
    // When the AI emits <<<OFFER_CREATE_GAME description="...">>> the
    // backend fires a `create_game_offer` event *before* the matching
    // chat_response_end arrives. We stash the description here and
    // attach a button once the assistant message renders. Cleared at
    // chat_response_start (new turn = stale offer).
    private pendingCreateFromScratchDescription: string | null = null;

    /** Modal-close handle for the LOAD_TEMPLATE confirmation popup. Set
     *  by openTemplateLoadConfirmModal, cleared on Confirm/Cancel/error. */
    private templateLoadModalClose: (() => void) | null = null;

    /** beforeunload guard — warns the user if they try to close / refresh /
     *  navigate away while the assistant is mid-response. Without this, a
     *  closed tab kills the chat stream and the user loses their in-flight
     *  LLM turn (the backend keeps running but their prompt disappears from
     *  the UI). Bound as a class field so `this` stays correct and
     *  removeEventListener would match if we ever need to detach. */
    private onBeforeUnload = (e: BeforeUnloadEvent) => {
        if (this.state !== State.STREAMING) return;
        e.preventDefault();
        // Most modern browsers ignore the custom string and show their own
        // generic "Leave site? Changes you made may not be saved." prompt,
        // but setting returnValue is still required to trigger the prompt.
        const msg = 'The AI Assistant is still responding — leaving this page will stop it. Leave anyway?';
        e.returnValue = msg;
        return msg;
    };

    constructor(options?: { headlessHeader?: boolean }) {
        this.ctx = EditorContext.instance;
        this.el = document.createElement('div');
        this.el.className = 'panel chat-panel';

        window.addEventListener('beforeunload', this.onBeforeUnload);

        // Build the header DOM either way — sessionBtn must exist so
        // headless callers (EditorView's tabs wrapper) can hoist it into
        // their own panel-header. When `headlessHeader` is true we do NOT
        // append the header div to this.el; the caller is responsible for
        // putting the title + sessionBtn somewhere visible.
        const header = document.createElement('div');
        header.className = 'panel-header';
        header.style.position = 'relative';

        const title = document.createElement('span');
        title.className = 'panel-title';
        title.textContent = t('chat.title');
        header.appendChild(title);

        this.sessionBtn = document.createElement('button');
        this.sessionBtn.className = 'panel-header-btn';
        this.sessionBtn.textContent = '+';
        this.sessionBtn.title = t('chat.sessionsTooltip');
        this.sessionBtn.addEventListener('click', () => this.toggleSessionMenu());
        header.appendChild(this.sessionBtn);

        if (!options?.headlessHeader) {
            this.el.appendChild(header);
        }

        // Messages
        this.messagesContainer = document.createElement('div');
        this.messagesContainer.className = 'chat-messages';
        this.el.appendChild(this.messagesContainer);

        // Input area
        const inputArea = document.createElement('div');
        inputArea.className = 'chat-input-area';

        // Asset chips row — shows above the textarea when the user has
        // staged "Use in chat" attachments from ModelGenPanel. Rendered
        // first so chips visually anchor above the input.
        this.chipsContainer = document.createElement('div');
        this.chipsContainer.className = 'chat-chips';
        this.chipsContainer.style.display = 'none';
        inputArea.appendChild(this.chipsContainer);

        const inputWrapper = document.createElement('div');
        inputWrapper.className = 'chat-input-wrapper';

        this.textarea = document.createElement('textarea');
        this.textarea.className = 'chat-textarea';
        this.textarea.placeholder = t('chat.placeholder');
        this.textarea.rows = document.body.classList.contains('mobile') ? 2 : 3;
        this.textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });
        this.textarea.addEventListener('input', () => this.autoResizeTextarea());

        this.sendBtn = document.createElement('button');
        this.sendBtn.className = 'chat-send-btn';
        this.sendBtn.textContent = t('chat.send');
        this.sendBtn.addEventListener('click', () => {
            if (this.state === State.STREAMING) {
                this.stopGeneration();
            } else {
                this.sendMessage();
            }
        });

        inputWrapper.appendChild(this.textarea);

        // Action row — agent picker on the left, send button on the right.
        // Lives inside the wrapper but below the textarea so text never
        // runs into either control.
        const inputActions = document.createElement('div');
        inputActions.className = 'chat-input-actions';

        this.agentSelect = document.createElement('select');
        this.agentSelect.className = 'chat-agent-select';
        this.agentSelect.title = 'Which agent handles this message';
        this.agentSelect.addEventListener('change', () => {
            this.selectedAgent = this.agentSelect!.value;
            this.updateAgentCaption();
        });
        inputActions.appendChild(this.agentSelect);
        inputActions.appendChild(this.sendBtn);

        inputWrapper.appendChild(inputActions);
        inputArea.appendChild(inputWrapper);

        this.agentCaption = document.createElement('div');
        this.agentCaption.className = 'chat-agent-caption';
        inputArea.appendChild(this.agentCaption);

        this.editingAgentBadge = document.createElement('div');
        this.editingAgentBadge.className = 'chat-editing-agent-badge';
        this.editingAgentBadge.title = 'Which CLI handles CREATE_GAME / FIX_GAME — change in Settings';
        inputArea.appendChild(this.editingAgentBadge);

        this.rebuildAgentOptions();
        this.updateEditingAgentBadge();

        // Keep the badge in sync when Settings changes the editing agent
        // (custom event dispatched from toolbar.ts on dropdown change).
        window.addEventListener('parallaxpro:editing-agent-changed', () => {
            this.updateEditingAgentBadge();
        });

        this.sessionIdLabel = document.createElement('div');
        this.sessionIdLabel.className = 'chat-session-id';
        inputArea.appendChild(this.sessionIdLabel);

        this.el.appendChild(inputArea);

        const supportRow = document.createElement('div');
        supportRow.className = 'chat-support-row';
        const discordLink = document.createElement('a');
        discordLink.href = 'https://discord.gg/GEWEdSaXfd';
        discordLink.target = '_blank';
        discordLink.rel = 'noopener';
        discordLink.className = 'chat-discord-link';
        discordLink.textContent = t('chat.discordLink');
        supportRow.appendChild(discordLink);
        this.el.appendChild(supportRow);

        // Typing sync (debounced)
        let typingSyncTimer = 0;
        this.textarea.addEventListener('input', () => {
            clearTimeout(typingSyncTimer);
            typingSyncTimer = window.setTimeout(() => {
                this.ctx.backend.sendWsMessage('chat_typing_sync', { text: this.textarea.value });
            }, 100);
        });

        this.registerHandlers();

        // Close session menu on outside click
        document.addEventListener('click', (e) => {
            if (!this.sessionMenu) return;
            if (this.sessionMenu.contains(e.target as Node)) return;
            const btn = this.el.querySelector('.panel-header-btn');
            if (btn && btn.contains(e.target as Node)) return;
            this.closeSessionMenu();
        });

        // ModelGenPanel posts this when a user clicks "+ chat" on a
        // library card. Decoupled via document event so the two panels
        // don't need refs to each other.
        document.addEventListener('parallax:chat-attach-asset', (e) => {
            const detail = (e as CustomEvent).detail as Partial<AssetAttachment> | undefined;
            if (!detail || !detail.id || !detail.path) return;
            this.addChip({
                id: detail.id,
                path: detail.path,
                thumbUrl: detail.thumbUrl ?? detail.path.replace(/\.glb$/, '.thumb.webp'),
                prompt: detail.prompt ?? 'generated model',
                upAxis: detail.upAxis,
                forwardAxis: detail.forwardAxis,
                estScaleM: detail.estScaleM ?? null,
                bbox: detail.bbox ?? null,
            });
        });

        this.restoreChipsFromStorage();

        this.showEmptyState();
    }

    // ── Asset chips (attached models) ───────────────────────────────

    /** Add a chip if not already attached. Dedupes by id. */
    private addChip(chip: AssetAttachment): void {
        if (this.chips.some(c => c.id === chip.id)) return;
        this.chips.push(chip);
        this.renderChips();
        this.persistChips();
    }

    private removeChip(id: string): void {
        this.chips = this.chips.filter(c => c.id !== id);
        this.renderChips();
        this.persistChips();
    }

    private renderChips(): void {
        if (!this.chipsContainer) return;
        this.chipsContainer.innerHTML = '';
        if (this.chips.length === 0) {
            this.chipsContainer.style.display = 'none';
            return;
        }
        this.chipsContainer.style.display = '';
        for (const chip of this.chips) {
            const el = document.createElement('div');
            el.className = 'chat-chip';
            el.title = chip.prompt;

            const img = document.createElement('img');
            img.className = 'chat-chip-thumb';
            img.src = chip.thumbUrl;
            img.alt = chip.prompt;
            img.loading = 'lazy';
            img.onerror = () => { img.style.display = 'none'; };
            el.appendChild(img);

            const label = document.createElement('span');
            label.className = 'chat-chip-label';
            label.textContent = chip.prompt.length > 40 ? chip.prompt.slice(0, 38) + '…' : chip.prompt;
            el.appendChild(label);

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'chat-chip-remove';
            removeBtn.textContent = '×';
            removeBtn.title = 'Remove';
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.removeChip(chip.id);
            });
            el.appendChild(removeBtn);

            this.chipsContainer.appendChild(el);
        }
    }

    private persistChips(): void {
        try {
            if (this.chips.length === 0) sessionStorage.removeItem(this.chipsStorageKey());
            else sessionStorage.setItem(this.chipsStorageKey(), JSON.stringify(this.chips));
        } catch { /* sessionStorage may be disabled in private mode */ }
    }

    private restoreChipsFromStorage(): void {
        try {
            const raw = sessionStorage.getItem(this.chipsStorageKey());
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                this.chips = parsed.filter((c: any) => c && typeof c.id === 'string' && typeof c.path === 'string');
                this.renderChips();
            }
        } catch { /* ignore */ }
    }

    // ── WebSocket event handlers ────────────────────────────────────

    private registerHandlers(): void {
        const ws = this.ctx.backend;

        ws.onWsMessage('connected', (data: any) => {
            this.setSessionId(data.chatSessionId as string);
            if (Array.isArray(data.availableAgents)) {
                this.availableCLIAgents = data.availableAgents as AgentOption[];
                this.ctx.state.availableAgents = data.availableAgents;
                this.rebuildAgentOptions();
                this.updateEditingAgentBadge();
            }
            if (typeof data.llmApiAvailable === 'boolean') {
                this.ctx.state.llmApiAvailable = data.llmApiAvailable;
            }
        });

        ws.onWsMessage('session_switched', (data: any) => {
            this.setSessionId(data.chatSessionId as string);
            this.syncStopButton();
        });

        ws.onWsMessage('chat_history', (data: any) => {
            this.loadHistory(data.messages ?? []);
            if (data.isGenerating) {
                this.transitionTo(State.STREAMING);
                this.showTypingIndicator();
            }
        });

        ws.onWsMessage('chat_cleared', () => {
            this.messages = [];
            this.messagesContainer.innerHTML = '';
            this.transitionTo(State.IDLE);
            this.hideTypingIndicator();
            this.showEmptyState();
        });

        // Streaming lifecycle
        ws.onWsMessage('chat_response_start', () => {
            this.transitionTo(State.STREAMING);
            this.pendingChunks = '';
            // Stale offer from an older turn — drop it. A fresh turn
            // that wants the button will fire create_game_offer again.
            this.pendingCreateFromScratchDescription = null;
            this.showTypingIndicator();
            this.scrollToBottom();
        });

        ws.onWsMessage('chat_response_chunk', (data: any) => {
            this.pendingChunks += data.content ?? '';
        });

        ws.onWsMessage('chat_response_end', (data: any) => {
            this.handleResponseEnd(data);
        });

        ws.onWsMessage('chat_generation_stopped', () => {
            this.handleGenerationStopped();
        });

        ws.onWsMessage('fix_progress', (data: any) => {
            if (!this.typingIndicator) return;
            // The typing indicator has three animated dots + a text
            // node. Swap that text node for the latest CLI status.
            const statusNode = this.typingIndicator.querySelector('.chat-typing-status') as HTMLElement | null;
            if (statusNode) {
                statusNode.textContent = ' ' + (data.text || 'Working...');
            } else {
                // Older indicator layout (just a trailing text node)
                // — replace it with a structured one so the hint
                // below has somewhere to live.
                const last = this.typingIndicator.lastChild;
                if (last && last.nodeType === Node.TEXT_NODE) last.remove();
                const s = document.createElement('span');
                s.className = 'chat-typing-status';
                s.textContent = ' ' + (data.text || 'Working...');
                this.typingIndicator.appendChild(s);
            }
            // Surface the "this can take a while" hint once, as soon
            // as the fixer reports any progress. Tells the user the
            // CLI is actually running + it's not stuck, so they don't
            // close the tab after 30 seconds of spinner.
            if (!this.typingIndicator.querySelector('.chat-typing-hint')) {
                const hint = document.createElement('div');
                hint.className = 'chat-typing-hint';
                hint.textContent = t('chat.fixerHint');
                this.typingIndicator.appendChild(hint);
            }
            this.scrollToBottom();
        });

        ws.onWsMessage('dialogue_done', () => {
            this.transitionTo(State.IDLE);
            this.hideTypingIndicator();
        });

        // Background CREATE_GAME build kicked off. The project is locked
        // for ~15–20 minutes; the rest of the editor is useless in this
        // state, so kick the user back to the project list where the
        // card shows a live timer + STOP + the build's current status.
        // Completion is announced via email on hosted / by the card
        // flipping back to normal on self-hosted.
        //
        // `editor_locked` fires when the user opens an ALREADY-locked
        // project via URL (e.g. refreshing the tab mid-build) — same
        // bounce. Drop the ?project= param so the back button doesn't
        // round-trip us into the locked editor.
        const bounceToList = () => {
            // This navigation is intentional (we're sending the user to
            // the project list so they can watch the build). The
            // beforeunload guard would otherwise intercept it and prompt
            // "leaving will stop the response" — which is technically
            // true but confusing here because we're the ones leaving.
            window.removeEventListener('beforeunload', this.onBeforeUnload);
            window.location.href = window.location.pathname;
        };
        ws.onWsMessage('generation_started', bounceToList);
        ws.onWsMessage('editor_locked', bounceToList);

        // AI suggested a from-scratch build. Stash the description; the
        // matching `chat_response_end` will render the message, and we
        // attach the button to it in `handleResponseEnd`.
        ws.onWsMessage('create_game_offer', (data: any) => {
            const desc = typeof data?.description === 'string' ? data.description.trim() : '';
            if (desc) this.pendingCreateFromScratchDescription = desc;
        });

        // The confirm-via-button path — backend tried to start the job
        // and failed. Re-enable the button and surface the error inline
        // so the user can retry or ask something else.
        ws.onWsMessage('create_game_offer_error', (data: any) => {
            const btns = this.messagesContainer.querySelectorAll<HTMLButtonElement>('.chat-create-scratch-btn');
            const last = btns[btns.length - 1];
            if (last) {
                last.disabled = false;
                this.restoreCreateScratchButtonContent(last);
            }
            const errMsg: ChatMessage = {
                role: 'assistant',
                content: `*Couldn't start the build: ${data?.error || 'unknown error'}*`,
            };
            this.messages.push(errMsg);
            this.renderMessageEl(errMsg);
            this.scrollToBottom();
        });

        // The agent emitted LOAD_TEMPLATE on a project that has had
        // ≥1 prior template load. Backend deferred the actual load and
        // is asking the user to confirm via a modal popup so a misread
        // can't silently nuke their current project.
        ws.onWsMessage('template_load_confirm_required', (data: any) => {
            const templateId = typeof data?.templateId === 'string' ? data.templateId : '';
            if (!templateId) return;
            this.openTemplateLoadConfirmModal(templateId);
        });

        // Confirm flow finished — close the modal if still open. The
        // file-tree push happens via the normal scene_reload / project
        // events that rebuildAndPush emits.
        ws.onWsMessage('template_load_completed', () => {
            if (this.templateLoadModalClose) {
                this.templateLoadModalClose();
                this.templateLoadModalClose = null;
            }
        });

        ws.onWsMessage('template_load_error', (data: any) => {
            if (this.templateLoadModalClose) {
                this.templateLoadModalClose();
                this.templateLoadModalClose = null;
            }
            const errMsg: ChatMessage = {
                role: 'assistant',
                content: `*Couldn't load the template: ${data?.error || 'unknown error'}*`,
            };
            this.messages.push(errMsg);
            this.renderMessageEl(errMsg);
            this.scrollToBottom();
        });

        // Anon user tried a CLI-spawning action (CREATE_GAME, FIX_GAME,
        // or publish). Render an AI-voiced bubble with the backend's
        // message + a Sign up button that pops the signup page. Handles
        // the "Starting..." create-scratch button reset too.
        ws.onWsMessage('signup_required', (data: any) => {
            const feature = (data && typeof data.feature === 'string') ? data.feature : '';
            const message = (data && typeof data.message === 'string')
                ? data.message
                : 'Sign up free to unlock this — your project will follow you over.';
            this.appendSignupPrompt(feature, message);
        });

        // Backend has a pending agent_feedback row for this project.
        // Replace the chat UI with a quick-feedback form until the user
        // submits (or dismisses, fix_game only). Fires on every connect
        // so a refresh re-prompts until they actually submit.
        ws.onWsMessage('feedback_required', (data: any) => {
            const id = Number(data?.feedbackId);
            const kind = data?.kind === 'create_game' ? 'create_game' : 'fix_game';
            const prompt = typeof data?.prompt === 'string' ? data.prompt : '';
            if (!Number.isFinite(id) || id <= 0) return;
            this.showFeedbackForm(id, kind, prompt);
        });


        // Submit acknowledged — form goes away, chat restores, the AI
        // follow-up turn is coming in on the usual chat_response_* path.
        ws.onWsMessage('feedback_submitted', () => {
            if (this.pendingFeedbackContent) {
                const msg: ChatMessage = { role: 'user', content: this.pendingFeedbackContent };
                this.messages.push(msg);
                this.renderMessageEl(msg);
                this.scrollToBottom();
                this.pendingFeedbackContent = null;
            }
            this.hideFeedbackForm();
        });

        // Soft dismiss of a fix_game prompt — hide for this session only.
        // Backend leaves the pending row intact, so the form re-fires
        // on the next WS connect until the user actually submits.
        ws.onWsMessage('feedback_dismissed', () => { this.hideFeedbackForm(); });

        // CREATE_GAME is strict — backend rejects dismiss attempts for
        // it. Leave the form up; no-op acknowledgement.
        ws.onWsMessage('feedback_dismiss_rejected', () => { /* form stays */ });

        // Revert failed (e.g. missing snapshot, parse error). Reset
        // the Restore button so the user can try again / submit instead.
        ws.onWsMessage('feedback_revert_error', (data: any) => {
            const btn = this.feedbackForm?.querySelector<HTMLButtonElement>('.chat-feedback-restore-btn');
            if (btn) {
                btn.disabled = false;
                btn.textContent = t('feedback.restoreButton');
            }
            const msg = (data && typeof data.error === 'string') ? data.error : 'Unable to restore.';
            window.alert(`Restore failed: ${msg}`);
        });

        ws.onWsMessage('__ws_disconnected', () => {
            if (this.state === State.STREAMING) {
                this.transitionTo(State.IDLE);
                this.hideTypingIndicator();
                this.isTodoDriving = false;
                const msg: ChatMessage = { role: 'assistant', content: '*Server restarted — please try your message again in a few seconds.*' };
                this.messages.push(msg);
                this.renderMessageEl(msg);
                this.scrollToBottom();
            }
        });

        ws.onWsMessage('ask_continue', (data: any) => {
            this.showContinuePrompt(data);
        });

        ws.onWsMessage('chat_sessions', (data: any) => {
            this.renderSessionList(data.sessions ?? []);
        });

        ws.onWsMessage('raw_session_files', (data: any) => {
            const files = data.files as { name: string; content: string }[];
            if (files && files.length > 0) {
                this.renderRawFilesPopup(data.sessionId as string, files);
            } else {
                navigator.clipboard.writeText(data.sessionId ?? '').then(() => {
                    const original = this.sessionIdLabel.textContent;
                    this.sessionIdLabel.textContent = t('chat.sessionIdCopied');
                    setTimeout(() => { this.sessionIdLabel.textContent = original; }, 1500);
                });
            }
        });

        // Tab sync
        ws.onWsMessage('chat_typing_sync', (data: any) => {
            this.textarea.value = data.text ?? '';
            this.autoResizeTextarea();
        });

        ws.onWsMessage('chat_user_message_sync', (data: any) => {
            this.hideEmptyState();
            const msg: ChatMessage = { role: 'user', content: data.content ?? '' };
            this.messages.push(msg);
            this.renderMessageEl(msg);
            this.scrollToBottom();
            this.textarea.value = '';
            this.textarea.style.height = 'auto';
        });

        // TODO events
        ws.onWsMessage('todo_list', (data: any) => {
            const todos: string[] = data.todos ?? [];
            this.renderTodoPanel(todos, data.currentIndex ?? 0);
            if (todos.length > 0) this.isTodoDriving = true;
        });

        ws.onWsMessage('todo_complete', (data: any) => {
            this.markTodoDone(data.index as number);
        });

        ws.onWsMessage('todo_all_done', () => {
            this.markAllTodosDone();
            this.isTodoDriving = false;
            this.transitionTo(State.IDLE);
            this.hideTypingIndicator();
        });

        ws.onWsMessage('todo_interrupted', () => {
            this.isTodoDriving = false;
            this.transitionTo(State.IDLE);
            this.hideTypingIndicator();
            if (this.todoPanel) {
                const status = this.todoPanel.querySelector('.todo-status');
                if (status) status.textContent = t('chat.todoPaused');
            }
        });

        ws.onWsMessage('todo_cleared', () => {
            this.isTodoDriving = false;
            this.transitionTo(State.IDLE);
            this.hideTypingIndicator();
            if (this.todoPanel) {
                this.todoPanel.remove();
                this.todoPanel = null;
            }
        });
    }

    // ── State machine ───────────────────────────────────────────────

    private transitionTo(next: State): void {
        this.state = next;
        this.syncStopButton();
    }

    private syncStopButton(): void {
        if (this.state === State.STREAMING) {
            this.sendBtn.textContent = t('chat.stop');
            this.sendBtn.classList.add('stop-mode');
        } else {
            this.sendBtn.textContent = t('chat.send');
            this.sendBtn.classList.remove('stop-mode');
        }
        this.sendBtn.disabled = false;
        // Lock session switching while a response is in flight — starting
        // a new chat or swapping sessions mid-stream leaves the current
        // run without a chat_session_id to attach its final message to.
        this.sessionBtn.disabled = this.state === State.STREAMING;
        this.sessionBtn.title = this.state === State.STREAMING
            ? t('chat.sessionsLocked')
            : t('chat.sessionsTooltip');
    }

    // ── Agent picker ────────────────────────────────────────────────

    /** localStorage 'chat_agent' may be stale (e.g. user picked LLM API on
     *  one backend, then opens another with no AI_BASE_URL). Validate
     *  against what the connected event advertised, falling back to the
     *  same default the settings panel would show. */
    private pickChatAgent(): string | undefined {
        const cliIds = (this.ctx.state.availableAgents ?? []).map(a => a.id);
        const valid = new Set<string>(cliIds);
        if (this.ctx.state.llmApiAvailable) valid.add('llm_api');
        if (valid.size === 0) return undefined;
        const saved = localStorage.getItem('chat_agent');
        if (saved && valid.has(saved)) return saved;
        return this.ctx.state.llmApiAvailable ? 'llm_api' : cliIds[0];
    }

    /** Same idea for the editing-agent (FIX_GAME) preference. */
    private pickEditingAgent(): string | undefined {
        const cliIds = (this.ctx.state.availableAgents ?? []).map(a => a.id);
        if (cliIds.length === 0) return undefined;
        const saved = localStorage.getItem('editing_agent');
        if (saved && cliIds.includes(saved)) return saved;
        return cliIds.includes('claude') ? 'claude' : cliIds[0];
    }

    /** Render the live "Editor: <CLI>" badge under the input. Hides when
     *  fewer than 2 CLIs are installed (no choice to make) or the backend
     *  hasn't reported the agent list yet. Idempotent — safe to call on
     *  every relevant state change. */
    private updateEditingAgentBadge(): void {
        if (!this.editingAgentBadge) return;
        const cliAgents = this.ctx.state.availableAgents ?? this.availableCLIAgents;
        if (cliAgents.length < 2) {
            this.editingAgentBadge.classList.remove('visible');
            this.editingAgentBadge.textContent = '';
            return;
        }
        const id = this.pickEditingAgent();
        // Backend labels already start with "Editing Agent: " (see
        // cli_availability.ts PROBES) — use as-is to avoid duplication.
        const label = cliAgents.find(a => a.id === id)?.label || `Editing Agent: ${id || '?'}`;
        this.editingAgentBadge.textContent = label;
        this.editingAgentBadge.classList.add('visible');
    }

    /** Rebuild <option> nodes in the picker. Runs at startup + after the
     *  connected event gives us the backend's availableAgents list. */
    private rebuildAgentOptions(): void {
        if (!this.agentSelect) return;
        const options = [...BUILTIN_AGENT_OPTIONS, ...this.availableCLIAgents];
        this.agentSelect.innerHTML = '';
        for (const opt of options) {
            const o = document.createElement('option');
            o.value = opt.id;
            o.textContent = opt.label;
            this.agentSelect.appendChild(o);
        }
        // Keep the current selection if still valid; otherwise fall back to auto.
        if (options.some(o => o.id === this.selectedAgent)) {
            this.agentSelect.value = this.selectedAgent;
        } else {
            this.selectedAgent = 'auto';
            this.agentSelect.value = 'auto';
        }
        this.updateAgentCaption();
    }

    /** Show a caption under the input explaining what the picked agent does. */
    private updateAgentCaption(): void {
        if (!this.agentCaption) return;
        const allOptions: AgentOption[] = [...BUILTIN_AGENT_OPTIONS, ...this.availableCLIAgents];
        const picked = allOptions.find(a => a.id === this.selectedAgent);
        const isCliAgent = this.availableCLIAgents.some(a => a.id === this.selectedAgent);
        const caption = picked?.caption || (isCliAgent ? CLI_AGENT_CAPTION : '');
        if (caption) {
            this.agentCaption.textContent = caption;
            this.agentCaption.classList.add('visible');
        } else {
            this.agentCaption.textContent = '';
            this.agentCaption.classList.remove('visible');
        }
    }

    /** Popup near the regenerate button listing which agent should re-handle
     *  the message. Skip "Auto" — for a regenerate the user is making an
     *  explicit choice. */
    private openRegenMenu(anchor: HTMLButtonElement, messageId: number): void {
        this.closeRegenMenu();
        const menu = document.createElement('div');
        menu.className = 'chat-regen-menu';

        const regenOptions: AgentOption[] = [...BUILTIN_AGENT_OPTIONS, ...this.availableCLIAgents];

        for (const opt of regenOptions) {
            const item = document.createElement('button');
            item.className = 'chat-regen-menu-item';
            const label = document.createElement('div');
            label.className = 'chat-regen-menu-label';
            label.textContent = `Regenerate with ${opt.label}`;
            item.appendChild(label);
            const hintText = opt.caption || (this.availableCLIAgents.some(a => a.id === opt.id) ? CLI_AGENT_CAPTION : '');
            if (hintText) {
                const hint = document.createElement('div');
                hint.className = 'chat-regen-menu-hint';
                hint.textContent = hintText;
                item.appendChild(hint);
            }
            item.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this.closeRegenMenu();
                this.ctx.backend.sendWsMessage('regenerate_response', { messageId, agent: opt.id });
            });
            menu.appendChild(item);
        }

        document.body.appendChild(menu);
        // Position the menu above-and-to-the-right of the clicked button.
        const rect = anchor.getBoundingClientRect();
        menu.style.top = `${rect.top - menu.offsetHeight - 4}px`;
        menu.style.left = `${Math.max(8, rect.left - menu.offsetWidth + rect.width)}px`;
        this.regenMenu = menu;

        const onDocClick = (ev: MouseEvent) => {
            if (!this.regenMenu) return;
            if (this.regenMenu.contains(ev.target as Node)) return;
            this.closeRegenMenu();
            document.removeEventListener('click', onDocClick);
        };
        setTimeout(() => document.addEventListener('click', onDocClick), 0);
    }

    private closeRegenMenu(): void {
        if (this.regenMenu) {
            this.regenMenu.remove();
            this.regenMenu = null;
        }
    }

    // ── Sending messages ────────────────────────────────────────────

    sendInitialMessage(text: string): void {
        const trySend = () => {
            if (this.ctx.backend.isConnected) {
                this.textarea.value = text;
                this.sendMessage();
            } else {
                setTimeout(trySend, 100);
            }
        };
        trySend();
    }

    private async sendMessage(): Promise<void> {
        const text = this.textarea.value.trim();
        if (!text || this.state === State.STREAMING) return;

        // Auto-save before sending so the AI has the latest scene state
        if (this.ctx.state.projectDirty) {
            await this.ctx.saveProject();
        }

        this.hideEmptyState();

        // Chips are attached as a parseable prefix block. AI sees the
        // paths inline; the user-visible bubble strips the block back to
        // chip cards in renderMessageEl. We persist the combined text
        // (block + user text) so chat history reload reproduces both.
        const chipBlock = formatChipsForAI(this.chips);
        const composed = chipBlock + text;

        const msg: ChatMessage = { role: 'user', content: composed };
        this.messages.push(msg);
        this.renderMessageEl(msg);

        // Clear the staging area now that the chips have shipped.
        this.chips = [];
        this.renderChips();
        this.persistChips();

        this.textarea.value = '';
        this.textarea.style.height = 'auto';

        this.transitionTo(State.STREAMING);
        this.pendingChunks = '';
        this.showTypingIndicator();
        this.ctx.backend.sendChatMessage(composed, this.selectedAgent, this.pickChatAgent(), this.pickEditingAgent());
        this.scrollToBottom();
    }

    private stopGeneration(): void {
        this.ctx.backend.sendWsMessage('stop_generation', {});
        this.transitionTo(State.IDLE);
        this.hideTypingIndicator();
        this.isTodoDriving = false;

        const msg: ChatMessage = { role: 'assistant', content: '*Generation stopped.*' };
        this.messages.push(msg);
        this.renderMessageEl(msg);
        this.scrollToBottom();
    }

    // ── Response handling ───────────────────────────────────────────

    private handleResponseEnd(data: any): void {
        const fullContent: string = data.fullContent ?? '';
        const fileChanges: FileChange[] = data.fileChanges ?? [];
        const messageId: number | undefined = data.messageId;

        // If todo is driving and there is no user-facing content, stay in streaming
        // state -- the next TODO iteration will send another response_start.
        if (this.isTodoDriving && !fullContent) {
            this.pendingChunks = '';
            if (fileChanges.length > 0) {
                const summary = this.buildFileChangeSummary(fileChanges);
                const msg: ChatMessage = { role: 'assistant', content: summary, fileChanges, id: messageId };
                this.messages.push(msg);
                this.renderMessageEl(msg);
                this.scrollToBottom();
            }
            return;
        }

        let displayContent = fullContent;

        if (!displayContent && fileChanges.length > 0) {
            displayContent = this.buildFileChangeSummary(fileChanges);
        }

        if (!displayContent && this.pendingChunks) {
            displayContent = this.pendingChunks;
        }

        this.pendingChunks = '';

        if (displayContent) {
            this.hideTypingIndicator();
            const msg: ChatMessage = {
                role: 'assistant',
                content: displayContent,
                fileChanges: fileChanges.length > 0 ? fileChanges : undefined,
                id: messageId,
            };
            this.messages.push(msg);
            this.renderMessageEl(msg);
            this.scrollToBottom();
        }

        // A matching OFFER_CREATE_GAME tool call came in earlier this
        // turn — attach the button to the assistant message we just
        // rendered. We use "last" rather than threading the element
        // through so the sync paths (chat_user_message_sync, etc.) keep
        // working without changes.
        if (this.pendingCreateFromScratchDescription) {
            this.appendCreateFromScratchButton(this.pendingCreateFromScratchDescription);
            this.pendingCreateFromScratchDescription = null;
        }

        // Re-show typing indicator if still generating (pipeline sends multiple chat_response_end)
        if (this.state === State.STREAMING) {
            this.showTypingIndicator();
            this.scrollToBottom();
        }
    }

    /** Attach a "Create from scratch" button to the latest assistant
     *  message. Clicking sends confirm_create_game to the backend which
     *  kicks off the long-running CLI build + bounces the editor back to
     *  the project list. Disabled after click so double-click is a no-op.
     *  Anon sessions hit the backend's signup_required refusal, which
     *  the signup_required WS handler below turns into an in-chat
     *  signup bubble + re-enables this button. */
    /** Reset the two-span layout used by `appendCreateFromScratchButton`.
     *  Called from error / signup-required paths that need to put a
     *  "Starting..." button back into its clickable state — wiping
     *  textContent there would orphan the badge span. */
    private restoreCreateScratchButtonContent(btn: HTMLButtonElement): void {
        btn.replaceChildren();
        const labelEl = document.createElement('span');
        labelEl.className = 'chat-create-scratch-btn__label';
        labelEl.textContent = t('chat.createScratch');
        const badgeEl = document.createElement('span');
        badgeEl.className = 'chat-create-scratch-btn__badge';
        badgeEl.textContent = t('chat.createScratchRecommended');
        btn.appendChild(labelEl);
        btn.appendChild(badgeEl);
    }

    private appendCreateFromScratchButton(description: string): void {
        const assistants = this.messagesContainer.querySelectorAll<HTMLElement>('.chat-message.assistant');
        const last = assistants[assistants.length - 1];
        if (!last) return;
        // Idempotent: if we've already attached a button here, skip.
        if (last.querySelector('.chat-create-scratch-btn')) return;

        const btn = document.createElement('button');
        btn.className = 'chat-create-scratch-btn chat-create-scratch-btn--recommended';
        // Two-line layout: action text on top, "Highly Recommended" badge
        // below. We build child spans (instead of textContent) so the
        // badge can carry its own emphasis styling + per-language label.
        const labelEl = document.createElement('span');
        labelEl.className = 'chat-create-scratch-btn__label';
        labelEl.textContent = t('chat.createScratch');
        const badgeEl = document.createElement('span');
        badgeEl.className = 'chat-create-scratch-btn__badge';
        badgeEl.textContent = t('chat.createScratchRecommended');
        btn.appendChild(labelEl);
        btn.appendChild(badgeEl);
        btn.addEventListener('click', () => {
            if (btn.disabled) return;
            btn.disabled = true;
            labelEl.textContent = 'Starting...';
            badgeEl.remove();
            // Send the LIVE editing-agent selection — `client.editingAgent`
            // on the backend is only refreshed by chat sends, so without
            // this the CREATE_GAME would use whatever was active at the
            // user's last chat message, ignoring any dropdown switch made
            // between the AI's offer and this click.
            this.ctx.backend.sendWsMessage('confirm_create_game', { description, editingAgent: this.pickEditingAgent() });
        });
        last.appendChild(btn);
        this.scrollToBottom();
    }

    /** Build a signup CTA bubble styled like an assistant message —
     *  the backend's signup_required event lands here for anon users
     *  who tried a CLI-spawning action (CREATE_GAME, FIX_GAME, publish).
     *  Also resets any "Starting..." create-scratch button that never
     *  got to fire, so the flow reads: click → brief spinner → AI-
     *  voice explanation + Sign up button. */
    private appendSignupPrompt(feature: string, message: string): void {
        // Reset any disabled create-scratch button — the click that set
        // it to "Starting..." didn't actually start anything.
        this.messagesContainer.querySelectorAll<HTMLButtonElement>('.chat-create-scratch-btn').forEach(btn => {
            if (btn.disabled || btn.textContent === 'Starting...') {
                btn.disabled = false;
                this.restoreCreateScratchButtonContent(btn);
            }
        });

        const messageEl = document.createElement('div');
        messageEl.className = 'chat-message assistant chat-signup-prompt';

        const bubble = document.createElement('div');
        bubble.className = 'chat-message-bubble';
        // Framing + backend's message verbatim so any feature-specific
        // wording (CREATE_GAME / FIX_GAME / publish) still reads right.
        const frame = document.createElement('p');
        frame.style.margin = '0 0 8px 0';
        if (feature === 'CREATE_GAME') {
            frame.textContent = t('signup.createGame');
        } else if (feature === 'FIX_GAME') {
            frame.textContent = t('signup.fixGame');
        } else if (feature === 'BUDGET') {
            frame.textContent = t('signup.budget');
        } else {
            frame.textContent = t('signup.default');
        }
        bubble.appendChild(frame);
        const detail = document.createElement('p');
        detail.style.margin = '0 0 12px 0';
        detail.style.color = 'var(--text-secondary, #b8c5d2)';
        detail.textContent = message;
        bubble.appendChild(detail);

        const btn = document.createElement('button');
        btn.className = 'chat-create-scratch-btn chat-signup-btn';
        btn.textContent = t('signup.button');
        btn.addEventListener('click', () => {
            const signupHref = window.location.hostname === 'localhost'
                ? 'http://localhost:5173/signup'
                : 'https://parallaxpro.ai/signup';
            // NOTE: no `noopener` — the popup posts `parallaxpro-auth-complete`
            // back to this window after successful signup/login so we can
            // pick up the new JWT and reload the editor without a manual
            // refresh. `noopener` would sever the opener link and break
            // that handoff.
            window.open(signupHref, 'parallaxpro-signup', 'width=520,height=680');
        });
        bubble.appendChild(btn);

        messageEl.appendChild(bubble);
        this.messagesContainer.appendChild(messageEl);
        this.scrollToBottom();
    }

    private handleGenerationStopped(): void {
        if (this.state !== State.STREAMING) return;
        this.transitionTo(State.IDLE);
        this.hideTypingIndicator();
        this.isTodoDriving = false;

        const msg: ChatMessage = { role: 'assistant', content: '*Generation stopped.*' };
        this.messages.push(msg);
        this.renderMessageEl(msg);
        this.scrollToBottom();
    }

    private showContinuePrompt(data: any): void {
        this.transitionTo(State.IDLE);
        this.hideTypingIndicator();

        const container = document.createElement('div');
        container.className = 'chat-continue-prompt';
        container.style.cssText = 'padding:8px 12px;margin:8px 0;background:var(--bg-tertiary);border-radius:6px;border:1px solid var(--border-color);';

        const text = document.createElement('div');
        text.style.cssText = 'margin-bottom:8px;font-size:var(--font-size-sm);color:var(--text-secondary);';
        text.textContent = data.message || `The AI has used ${data.roundTrip} round-trips. Continue?`;
        container.appendChild(text);

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;';

        const continueBtn = document.createElement('button');
        continueBtn.textContent = t('chat.continue');
        continueBtn.style.cssText = 'padding:4px 12px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:var(--font-size-sm);';
        continueBtn.addEventListener('click', () => {
            container.remove();
            this.transitionTo(State.STREAMING);
            this.showTypingIndicator();
            this.ctx.backend.sendWsMessage('continue_generation', {
                roundTrip: data.roundTrip,
                toolResults: data.toolResults,
            });
        });

        const stopBtn = document.createElement('button');
        stopBtn.textContent = t('chat.stop');
        stopBtn.style.cssText = 'padding:4px 12px;background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;font-size:var(--font-size-sm);';
        stopBtn.addEventListener('click', () => {
            container.remove();
            const msg: ChatMessage = { role: 'assistant', content: '*Stopped by user.*' };
            this.messages.push(msg);
            this.renderMessageEl(msg);
            this.scrollToBottom();
        });

        btnRow.appendChild(continueBtn);
        btnRow.appendChild(stopBtn);
        container.appendChild(btnRow);

        this.messagesContainer.appendChild(container);
        this.scrollToBottom();
    }

    // ── History loading ─────────────────────────────────────────────

    private loadHistory(rawMessages: { id?: number; role: string; content: string; fileChanges?: FileChange[]; feedback?: string | null; offerCreateGameDescription?: string | null }[]): void {
        this.messages = [];
        this.messagesContainer.innerHTML = '';

        if (rawMessages.length === 0) {
            this.showEmptyState();
            return;
        }

        this.hideEmptyState();

        for (const raw of rawMessages) {
            const msg: ChatMessage = {
                id: raw.id,
                role: raw.role as 'user' | 'assistant',
                content: raw.content || '',
                fileChanges: raw.fileChanges,
                feedback: raw.feedback || null,
                offerCreateGameDescription: raw.offerCreateGameDescription || null,
            };

            if (msg.role === 'assistant' && !msg.content && msg.fileChanges && msg.fileChanges.length > 0) {
                msg.content = this.buildFileChangeSummary(msg.fileChanges);
            }

            if (msg.role === 'assistant' && !msg.content) continue;

            this.messages.push(msg);
            this.renderMessageEl(msg);
        }

        this.scrollToBottom();
    }

    // ── Message rendering ───────────────────────────────────────────

    private renderMessageEl(msg: ChatMessage): void {
        const messageEl = document.createElement('div');
        messageEl.className = `chat-message ${msg.role}`;

        let displayContent = msg.content;
        displayContent = displayContent.replace(/\[SYSTEM\][\s\S]*$/, '').trim();

        // User messages may have an attached-assets prefix block — strip
        // it here and render chip cards above the text bubble. Assistant
        // messages are not parsed (the AI doesn't generate this format).
        let bubbleChips: AssetAttachment[] = [];
        if (msg.role === 'user') {
            const parsed = parseChipsFromContent(displayContent);
            bubbleChips = parsed.chips;
            displayContent = parsed.cleanText;
        }

        if (bubbleChips.length > 0) {
            const chipsRow = document.createElement('div');
            chipsRow.className = 'chat-message-chips';
            for (const chip of bubbleChips) {
                const el = document.createElement('div');
                el.className = 'chat-message-chip';
                el.title = chip.prompt;
                const img = document.createElement('img');
                img.className = 'chat-message-chip-thumb';
                img.src = chip.thumbUrl;
                img.alt = chip.prompt;
                img.loading = 'lazy';
                img.onerror = () => { img.style.display = 'none'; };
                el.appendChild(img);
                const label = document.createElement('span');
                label.className = 'chat-message-chip-label';
                label.textContent = chip.prompt.length > 40 ? chip.prompt.slice(0, 38) + '…' : chip.prompt;
                el.appendChild(label);
                chipsRow.appendChild(el);
            }
            messageEl.appendChild(chipsRow);
        }

        const bubble = document.createElement('div');
        bubble.className = 'chat-message-bubble';
        bubble.innerHTML = this.renderMarkdown(displayContent);
        messageEl.appendChild(bubble);

        // Prominent "template loaded, project was replaced" banner for
        // LOAD_TEMPLATE turns. The small revert button in the footer is
        // easy to miss, and template loads nuke the user's whole file
        // tree — they need to see the restore affordance up-front so a
        // wrong template doesn't feel catastrophic.
        if (msg.role === 'assistant'
            && msg.id
            && msg.fileChanges
            && msg.fileChanges.some(fc => fc.type === 'template_load')) {
            const banner = document.createElement('div');
            banner.className = 'chat-template-load-banner';
            const text = document.createElement('div');
            text.className = 'chat-template-load-text';
            text.textContent = t('chat.templateBanner');
            banner.appendChild(text);
            const restoreBtn = document.createElement('button');
            restoreBtn.className = 'chat-template-load-restore-btn';
            restoreBtn.textContent = t('chat.templateRestore');
            restoreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm('Restore your project to BEFORE the template was loaded? The loaded template will be discarded.')) {
                    this.ctx.backend.sendRevertToBeforeMessage(msg.id!);
                }
            });
            banner.appendChild(restoreBtn);
            messageEl.appendChild(banner);
        }

        if (msg.role === 'assistant') {
            const footer = document.createElement('div');
            footer.className = 'chat-message-footer';

            // Changes applied tag + revert buttons
            if (msg.fileChanges && msg.fileChanges.length > 0) {
                const tag = document.createElement('span');
                tag.className = 'chat-changes-tag';
                tag.textContent = t('chat.changesApplied');
                footer.appendChild(tag);

                if (msg.id) {
                    const revertBeforeBtn = document.createElement('button');
                    revertBeforeBtn.className = 'chat-revert-btn';
                    revertBeforeBtn.textContent = t('chat.revertBefore');
                    revertBeforeBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (confirm('Revert project to BEFORE this change? This message and all later changes will be discarded.')) {
                            this.ctx.backend.sendRevertToBeforeMessage(msg.id!);
                        }
                    });
                    footer.appendChild(revertBeforeBtn);

                    const revertBtn = document.createElement('button');
                    revertBtn.className = 'chat-revert-btn';
                    revertBtn.textContent = t('chat.revertHere');
                    revertBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (confirm('Revert project to this point? All later changes will be discarded.')) {
                            this.ctx.backend.sendRevertToMessage(msg.id!);
                        }
                    });
                    footer.appendChild(revertBtn);
                }
            }

            // Feedback + regenerate buttons (skip pipeline status messages)
            const isStatusMsg = /^(Building your game\.\.\.|Selecting template|Analyzing the issue)/i.test(msg.content);
            if (msg.id && !isStatusMsg) {
                const actions = document.createElement('div');
                actions.className = 'chat-feedback-actions';

                const makeBtn = (iconDef: any, title: string): HTMLButtonElement => {
                    const btn = document.createElement('button');
                    btn.className = 'chat-feedback-btn';
                    btn.title = title;
                    btn.appendChild(icon(iconDef, 13));
                    return btn;
                };

                const thumbUp = makeBtn(ThumbsUp, 'Good response');
                const thumbDown = makeBtn(ThumbsDown, 'Bad response');
                const regen = makeBtn(RefreshCw, 'Regenerate response');

                if (msg.feedback === 'up') thumbUp.classList.add('active-up');
                if (msg.feedback === 'down') thumbDown.classList.add('active-down');

                thumbUp.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const isActive = thumbUp.classList.contains('active-up');
                    const newFeedback = isActive ? null : 'up';
                    this.ctx.backend.sendWsMessage('message_feedback', { messageId: msg.id, feedback: newFeedback || 'none' });
                    thumbUp.classList.toggle('active-up', !isActive);
                    thumbDown.classList.remove('active-down');
                    msg.feedback = newFeedback;
                });

                thumbDown.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const isActive = thumbDown.classList.contains('active-down');
                    const newFeedback = isActive ? null : 'down';
                    this.ctx.backend.sendWsMessage('message_feedback', { messageId: msg.id, feedback: newFeedback || 'none' });
                    thumbDown.classList.toggle('active-down', !isActive);
                    thumbUp.classList.remove('active-up');
                    msg.feedback = newFeedback;
                });

                regen.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.openRegenMenu(regen, msg.id!);
                });

                actions.appendChild(thumbUp);
                actions.appendChild(thumbDown);
                actions.appendChild(regen);
                footer.appendChild(actions);
            }

            if (footer.childNodes.length > 0) messageEl.appendChild(footer);
        }

        this.messagesContainer.appendChild(messageEl);

        // If this assistant message had the LLM's OFFER_CREATE_GAME
        // tool attached, re-render the "Create from scratch" button.
        // Matches the live path (pendingCreateFromScratchDescription)
        // but works for history loaded from the DB on refresh, so the
        // button doesn't vanish across sessions.
        if (msg.role === 'assistant' && msg.offerCreateGameDescription) {
            this.appendCreateFromScratchButton(msg.offerCreateGameDescription);
        }

        // Keep typing indicator at the bottom
        if (this.typingIndicator && this.messagesContainer.contains(this.typingIndicator)) {
            this.messagesContainer.appendChild(this.typingIndicator);
        }
    }

    // ── Markdown rendering ──────────────────────────────────────────

    private renderMarkdown(text: string): string {
        if (!text) return '';

        let html = text;

        // Escape HTML entities
        html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        // Fenced code blocks
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
            return `<pre><code>${code.trim()}</code></pre>`;
        });

        // Inline code
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

        // Bold and italic
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

        // Unordered lists
        html = html.replace(/^[*\-] (.+)$/gm, '<li>$1</li>');
        html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

        // Ordered lists
        html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

        // Paragraphs
        html = html.replace(/\n\n/g, '</p><p>');
        html = `<p>${html}</p>`;
        html = html.replace(/<p>\s*<\/p>/g, '');

        return html;
    }

    // ── File change summary ─────────────────────────────────────────

    private buildFileChangeSummary(changes: FileChange[]): string {
        if (changes.length === 0) return '';
        const lines = changes.map(fc => {
            const filename = fc.path.split('/').pop() || fc.path;
            const verb = fc.type === 'created' ? 'Created' : fc.type === 'deleted' ? 'Deleted' : 'Updated';
            return `${verb} \`${filename}\``;
        });
        return lines.join('\n');
    }

    // ── Typing indicator ────────────────────────────────────────────

    private showTypingIndicator(): void {
        this.hideTypingIndicator();
        this.typingIndicator = document.createElement('div');
        this.typingIndicator.className = 'chat-typing-indicator';
        for (let i = 0; i < 3; i++) {
            const dot = document.createElement('span');
            dot.className = 'chat-typing-dot';
            this.typingIndicator.appendChild(dot);
        }
        const status = document.createElement('span');
        status.className = 'chat-typing-status';
        status.textContent = ' ' + t('chat.thinking');
        this.typingIndicator.appendChild(status);
        this.messagesContainer.appendChild(this.typingIndicator);
    }

    private hideTypingIndicator(): void {
        if (this.typingIndicator) {
            this.typingIndicator.remove();
            this.typingIndicator = null;
        }
    }

    // ── Feedback form ───────────────────────────────────────────────
    // Replaces the chat UI with a quick rating + notes form after
    // CREATE_GAME / FIX_GAME completes. Thumbs-up/down required;
    // FIX_GAME has a Dismiss (soft, re-prompts on reload);
    // CREATE_GAME doesn't. Submit unlocks the chat and triggers an
    // AI follow-up turn via the backend.

    private showFeedbackForm(feedbackId: number, kind: 'create_game' | 'fix_game', prompt: string): void {
        // Already showing feedback — don't stack; reuse the existing form
        // if it matches this id, otherwise swap it out.
        const existingForm = this.feedbackForm?.querySelector('.chat-feedback-form') as HTMLElement | null;
        if (existingForm && existingForm.dataset.feedbackId === String(feedbackId)) return;
        this.hideFeedbackForm();

        // Overlay the feedback form on top of the chat panel with a
        // translucent backdrop. The chat stays visible underneath so
        // users know the AI Assistant is there — they just need to
        // finish feedback first.
        this.feedbackChatEls = [];

        const backdrop = document.createElement('div');
        backdrop.className = 'chat-feedback-backdrop';

        const form = document.createElement('div');
        form.className = 'chat-feedback-form';
        form.dataset.feedbackId = String(feedbackId);
        form.dataset.kind = kind;

        // Shared dismiss handler — bottom action bar AND the top-right close
        // button both invoke this. Optimistically hides the form locally; the
        // backend ack via `feedback_dismissed` is idempotent.
        const dismissFeedback = () => {
            this.ctx.backend.sendWsMessage('feedback_dismiss', { feedbackId });
            this.hideFeedbackForm();
        };

        // Top-right close (X). The form is tall enough that the dismiss
        // button at the bottom can scroll out of view on small panels — the
        // X button stays anchored at the top so it's always reachable.
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'chat-feedback-close-btn';
        closeBtn.appendChild(icon(X, 16));
        closeBtn.title = t('feedback.dismissTooltip');
        closeBtn.setAttribute('aria-label', t('feedback.dismiss'));
        closeBtn.addEventListener('click', dismissFeedback);
        form.appendChild(closeBtn);

        const title = document.createElement('div');
        title.className = 'chat-feedback-title';
        title.textContent = kind === 'create_game'
            ? t('feedback.titleCreate')
            : t('feedback.titleFix');
        form.appendChild(title);

        const thankYou = document.createElement('div');
        thankYou.className = 'chat-feedback-thankyou';
        thankYou.textContent = t('feedback.thankYou');
        form.appendChild(thankYou);

        const subtitle = document.createElement('div');
        subtitle.className = 'chat-feedback-subtitle';
        subtitle.textContent = kind === 'create_game'
            ? t('feedback.promptLabelCreate')
            : t('feedback.promptLabelFix');
        form.appendChild(subtitle);

        const promptBlock = document.createElement('blockquote');
        promptBlock.className = 'chat-feedback-prompt';
        promptBlock.textContent = prompt || t('feedback.noPrompt');
        form.appendChild(promptBlock);

        // Thumbs up / down — one required. Using lucide icons, not emojis.
        const rateLabel = document.createElement('div');
        rateLabel.className = 'chat-feedback-label';
        rateLabel.textContent = t('feedback.rateLabel');
        form.appendChild(rateLabel);

        let rating: 'up' | 'down' | null = null;
        const rateRow = document.createElement('div');
        rateRow.className = 'chat-feedback-rate-row';

        const upBtn = document.createElement('button');
        upBtn.type = 'button';
        upBtn.className = 'chat-feedback-rate-btn';
        upBtn.appendChild(icon(ThumbsUp, 20));
        const upLabel = document.createElement('span');
        upLabel.textContent = t('feedback.worked');
        upBtn.appendChild(upLabel);

        const downBtn = document.createElement('button');
        downBtn.type = 'button';
        downBtn.className = 'chat-feedback-rate-btn';
        downBtn.appendChild(icon(ThumbsDown, 20));
        const downLabel = document.createElement('span');
        downLabel.textContent = t('feedback.notWorked');
        downBtn.appendChild(downLabel);

        const updateRating = () => {
            upBtn.classList.toggle('selected', rating === 'up');
            downBtn.classList.toggle('selected', rating === 'down');
            submitBtn.disabled = rating === null;
        };
        upBtn.addEventListener('click', () => { rating = 'up'; updateRating(); });
        downBtn.addEventListener('click', () => { rating = 'down'; updateRating(); });

        rateRow.appendChild(upBtn);
        rateRow.appendChild(downBtn);
        form.appendChild(rateRow);

        const notesLabel = document.createElement('div');
        notesLabel.className = 'chat-feedback-label';
        notesLabel.textContent = t('feedback.notesLabel');
        form.appendChild(notesLabel);

        const notes = document.createElement('textarea');
        notes.className = 'chat-feedback-notes';
        notes.rows = 3;
        notes.placeholder = t('feedback.notesPlaceholder');
        // Auto-grow as the user types. CSS pins resize:none so the
        // drag handle is gone; we drive the height here instead.
        const autoGrow = () => {
            notes.style.height = 'auto';
            notes.style.height = notes.scrollHeight + 'px';
        };
        notes.addEventListener('input', autoGrow);
        form.appendChild(notes);

        // CREATE_GAME-only: restore the project to how it was before
        // the build. The agent_feedback row stores the pre-build
        // snapshot inline, so backend flips project_data back in one
        // UPDATE. Sits outside the normal submit flow — it's the
        // escape hatch for a build the user doesn't want to keep.
        if (kind === 'create_game') {
            const restoreRow = document.createElement('div');
            restoreRow.className = 'chat-feedback-restore-row';
            const restoreNote = document.createElement('div');
            restoreNote.className = 'chat-feedback-restore-note';
            restoreNote.textContent = t('feedback.restoreNote');
            restoreRow.appendChild(restoreNote);
            const restoreBtn = document.createElement('button');
            restoreBtn.type = 'button';
            restoreBtn.className = 'chat-feedback-restore-btn';
            restoreBtn.textContent = t('feedback.restoreButton');
            restoreBtn.addEventListener('click', () => {
                if (!confirm('Restore the project to how it was BEFORE this CREATE_GAME build? The generated files will be discarded.')) return;
                restoreBtn.disabled = true;
                restoreBtn.textContent = t('feedback.restoring');
                this.ctx.backend.sendWsMessage('feedback_revert', {
                    feedbackId,
                    text: notes.value.trim(),
                });
            });
            restoreRow.appendChild(restoreBtn);
            form.appendChild(restoreRow);
        }

        // Actions — submit sticks bottom-right; dismiss available for both
        // create_game and fix_game so users can skip the form without
        // typing anything.
        const actions = document.createElement('div');
        actions.className = 'chat-feedback-actions';

        {
            const dismissBtn = document.createElement('button');
            dismissBtn.type = 'button';
            dismissBtn.className = 'chat-feedback-dismiss-btn';
            dismissBtn.appendChild(icon(X, 14));
            const dismissLabel = document.createElement('span');
            dismissLabel.textContent = t('feedback.dismiss');
            dismissBtn.appendChild(dismissLabel);
            dismissBtn.title = t('feedback.dismissTooltip');
            dismissBtn.addEventListener('click', dismissFeedback);
            actions.appendChild(dismissBtn);
        }

        const spacer = document.createElement('div');
        spacer.style.flex = '1 1 auto';
        actions.appendChild(spacer);

        const submitBtn = document.createElement('button');
        submitBtn.type = 'button';
        submitBtn.className = 'chat-feedback-submit-btn';
        submitBtn.textContent = t('feedback.submit');
        submitBtn.disabled = true;
        submitBtn.addEventListener('click', () => {
            if (!rating) return;
            submitBtn.disabled = true;
            submitBtn.textContent = t('feedback.submitting');
            const notesText = notes.value.trim();
            const ratingText = rating === 'up' ? 'It worked' : 'It did not work';
            const lines = [`**Feedback on ${kind === 'create_game' ? 'the build' : 'the last change'}** — ${ratingText}.`, '', `> Original request: ${prompt || '(not captured)'}`];
            if (notesText) lines.push('', `Notes: ${notesText}`);
            this.pendingFeedbackContent = lines.join('\n');
            this.ctx.backend.sendWsMessage('feedback_submit', {
                feedbackId,
                rating,
                text: notesText,
            });
        });
        actions.appendChild(submitBtn);

        form.appendChild(actions);

        backdrop.appendChild(form);
        this.feedbackForm = backdrop;
        this.el.style.position = 'relative';
        this.el.appendChild(backdrop);
    }

    private hideFeedbackForm(): void {
        if (this.feedbackForm) {
            this.feedbackForm.remove();
            this.feedbackForm = null;
        }
        for (const el of this.feedbackChatEls) {
            el.style.display = '';
        }
        this.feedbackChatEls = [];
    }

    /**
     * Confirmation popup for the agent's 2nd-and-later LOAD_TEMPLATE on a
     * project. The first load is silent; later loads gate here so the
     * agent can't silently overwrite the user's work on a misread.
     * Confirm → fires confirm_template_load WS, the backend swaps in
     * the template and emits template_load_completed (closes the modal).
     * Cancel → closes the modal locally; backend gets cancel_template_load
     * (currently a no-op, kept for symmetry).
     */
    private openTemplateLoadConfirmModal(templateId: string): void {
        // If a stale modal is already open (shouldn't happen in normal
        // flow), close it first so we don't stack.
        if (this.templateLoadModalClose) {
            this.templateLoadModalClose();
            this.templateLoadModalClose = null;
        }

        const body = document.createElement('div');
        body.style.lineHeight = '1.5';
        const p1 = document.createElement('p');
        p1.style.margin = '0 0 10px';
        // Build sentence with safe DOM nodes — avoids HTML injection if
        // a template id ever contains markup-y characters.
        p1.appendChild(document.createTextNode('The AI Assistant wants to load the '));
        const tname = document.createElement('strong');
        tname.textContent = templateId;
        p1.appendChild(tname);
        p1.appendChild(document.createTextNode(' template. This will '));
        const replace = document.createElement('strong');
        replace.textContent = 'replace your current project';
        p1.appendChild(replace);
        p1.appendChild(document.createTextNode('.'));
        const p2 = document.createElement('p');
        p2.style.margin = '0';
        p2.style.color = 'var(--ink-3, #888)';
        p2.style.fontSize = '12px';
        p2.textContent = 'You can revert by pressing "Restore my previous project" in the chat anytime.';
        body.appendChild(p1);
        body.appendChild(p2);

        const handle = showModal({
            title: 'Replace your project?',
            body,
            width: '440px',
            closeOnBackdrop: false,
            buttons: [
                {
                    label: 'Cancel',
                    action: () => {
                        try { this.ctx.backend.sendWsMessage('cancel_template_load', { templateId }); } catch {}
                        this.templateLoadModalClose?.();
                        this.templateLoadModalClose = null;
                    },
                },
                {
                    label: 'Confirm — replace project',
                    primary: true,
                    action: () => {
                        try { this.ctx.backend.sendWsMessage('confirm_template_load', { templateId }); } catch {}
                        // Don't close yet — wait for template_load_completed
                        // to confirm the swap actually landed. If it errors
                        // the template_load_error handler will close + show
                        // the message.
                    },
                },
            ],
            onClose: () => {
                // Backdrop close is disabled; this fires on programmatic
                // close (after Cancel / Confirm-then-completed). Just
                // clear the handle so the next popup starts fresh.
                this.templateLoadModalClose = null;
            },
        });
        this.templateLoadModalClose = handle.close;
    }

    // ── Empty state ─────────────────────────────────────────────────

    private showEmptyState(): void {
        if (this.emptyState) return;
        this.emptyState = document.createElement('div');
        this.emptyState.className = 'chat-empty-state';
        const logo = document.createElement('img');
        logo.src = `${import.meta.env.BASE_URL}logos/main_logo.png`;
        logo.alt = 'Logo';
        logo.className = 'chat-empty-logo';
        this.emptyState.appendChild(logo);
        this.messagesContainer.appendChild(this.emptyState);
    }

    private hideEmptyState(): void {
        if (this.emptyState) {
            this.emptyState.remove();
            this.emptyState = null;
        }
    }

    // ── Scroll ──────────────────────────────────────────────────────

    private scrollToBottom(): void {
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }

    private autoResizeTextarea(): void {
        this.textarea.style.height = 'auto';
        this.textarea.style.height = Math.min(this.textarea.scrollHeight, 150) + 'px';
    }

    // ── Session menu ────────────────────────────────────────────────

    /** Public so a wrapper that hoists sessionBtn into its own header can
     *  re-bind the click — the original onClick still fires here unchanged. */
    toggleSessionMenu(): void {
        if (this.sessionMenu) {
            this.closeSessionMenu();
        } else {
            this.ctx.backend.sendListSessions();
        }
    }

    private closeSessionMenu(): void {
        if (this.sessionMenu) {
            this.sessionMenu.remove();
            this.sessionMenu = null;
        }
    }

    private renderSessionList(sessions: ChatSession[]): void {
        this.closeSessionMenu();

        this.sessionMenu = document.createElement('div');
        this.sessionMenu.className = 'chat-session-menu';

        const newItem = document.createElement('div');
        newItem.className = 'chat-session-new';
        newItem.textContent = t('chat.newChat');
        newItem.addEventListener('click', () => {
            this.closeSessionMenu();
            this.ctx.backend.sendWsMessage('new_chat_session', {});
        });
        this.sessionMenu.appendChild(newItem);

        for (const session of sessions) {
            const item = document.createElement('div');
            item.className = 'chat-session-item' + (session.active ? ' active' : '');

            const preview = document.createElement('div');
            preview.className = 'session-preview';
            // Full preview (often a multi-line paragraph) on hover so
            // users can still see it, but display a short single-line
            // teaser in the dropdown so the list is actually scannable.
            const raw = (session.preview || '').replace(/\s+/g, ' ').trim();
            const MAX = 60;
            preview.textContent = raw.length > MAX ? raw.slice(0, MAX).trimEnd() + '…' : raw;
            preview.title = raw;
            item.appendChild(preview);

            const date = document.createElement('div');
            date.className = 'session-date';
            date.textContent = this.formatDate(session.createdAt);
            item.appendChild(date);

            item.addEventListener('click', () => {
                this.closeSessionMenu();
                if (!session.active) {
                    this.ctx.backend.sendSwitchSession(session.id);
                }
            });

            this.sessionMenu.appendChild(item);
        }

        // Mount the dropdown next to whichever header actually owns the
        // session button — this works whether the header lives inside
        // this.el or has been hoisted into a wrapper (tabs panel).
        const host = this.sessionBtn.parentElement
            ?? (this.el.querySelector('.panel-header') as HTMLElement | null)
            ?? this.el;
        host.appendChild(this.sessionMenu);
    }

    private formatDate(dateStr: string): string {
        try {
            const d = new Date(dateStr.includes('T') || dateStr.endsWith('Z') ? dateStr : dateStr + 'Z');
            if (isNaN(d.getTime())) return 'Just now';
            const diff = Date.now() - d.getTime();
            if (diff < 60000) return 'Just now';
            if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
            if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
            return d.toLocaleDateString();
        } catch {
            return 'Just now';
        }
    }

    // ── Session ID label + raw files ────────────────────────────────

    private setSessionId(sessionId: string): void {
        if (!sessionId) return;
        this.currentSessionId = sessionId;
        const display = sessionId.length > 20
            ? sessionId.slice(0, 8) + '...' + sessionId.slice(-8)
            : sessionId;
        this.sessionIdLabel.textContent = `Session: ${display}`;
        this.sessionIdLabel.title = t('chat.sessionIdTooltip');
        this.sessionIdLabel.style.cursor = 'pointer';

        const newLabel = this.sessionIdLabel.cloneNode(true) as HTMLElement;
        this.sessionIdLabel.replaceWith(newLabel);
        (this as any).sessionIdLabel = newLabel;
        newLabel.addEventListener('click', () => {
            this.ctx.backend.sendWsMessage('get_raw_session_files', {});
        });
    }

    // ── Raw files popup ─────────────────────────────────────────────

    private renderRawFilesPopup(sessionId: string, files: { name: string; content: string }[]): void {
        if (this.rawFilesOverlay && this.rawFilesContainer && document.body.contains(this.rawFilesOverlay)) {
            this.updateRawFilesContent(files);
            return;
        }

        this.closeRawFilesPopup();

        const overlay = document.createElement('div');
        overlay.className = 'raw-files-overlay';

        const popup = document.createElement('div');
        popup.className = 'raw-files-popup';

        const header = document.createElement('div');
        header.className = 'raw-files-header';

        const title = document.createElement('span');
        title.textContent = t('chat.rawFilesTitle');
        title.style.fontWeight = '600';
        header.appendChild(title);

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '\u2715';
        closeBtn.className = 'raw-files-close';
        closeBtn.addEventListener('click', () => this.closeRawFilesPopup());
        header.appendChild(closeBtn);

        popup.appendChild(header);

        const sessionLabel = document.createElement('div');
        sessionLabel.className = 'raw-files-session-id';
        sessionLabel.textContent = sessionId;
        popup.appendChild(sessionLabel);

        const container = document.createElement('div');
        container.className = 'raw-files-container';
        this.rawFilesContainer = container;

        if (files.length === 0) {
            const empty = document.createElement('div');
            empty.style.padding = '16px';
            empty.style.color = 'var(--text-secondary)';
            empty.textContent = t('chat.rawFilesEmpty');
            container.appendChild(empty);
        } else {
            for (const file of files) {
                container.appendChild(this.createRawFileSection(file));
            }
        }

        popup.appendChild(container);
        overlay.appendChild(popup);
        document.body.appendChild(overlay);
        this.rawFilesOverlay = overlay;

        this.rawFilesRefreshTimer = window.setInterval(() => {
            if (!this.rawFilesOverlay || !document.body.contains(this.rawFilesOverlay)) {
                clearInterval(this.rawFilesRefreshTimer);
                this.rawFilesRefreshTimer = 0;
                return;
            }
            this.ctx.backend.sendWsMessage('get_raw_session_files', {});
        }, 3000);
    }

    private updateRawFilesContent(files: { name: string; content: string }[]): void {
        if (!this.rawFilesContainer) return;

        const scrollTop = this.rawFilesContainer.scrollTop;
        const existing = this.rawFilesContainer.querySelectorAll('.raw-file-section');

        for (let i = 0; i < files.length; i++) {
            if (i < existing.length) {
                const nameEl = existing[i].querySelector('.raw-file-name');
                const contentEl = existing[i].querySelector('.raw-file-content');
                if (nameEl) nameEl.textContent = files[i].name;
                if (contentEl && contentEl.textContent !== files[i].content) {
                    contentEl.textContent = files[i].content;
                }
            } else {
                this.rawFilesContainer.appendChild(this.createRawFileSection(files[i]));
            }
        }

        while (this.rawFilesContainer.children.length > files.length) {
            this.rawFilesContainer.removeChild(this.rawFilesContainer.lastChild!);
        }

        this.rawFilesContainer.scrollTop = scrollTop;
    }

    private createRawFileSection(file: { name: string; content: string }): HTMLElement {
        const section = document.createElement('div');
        section.className = 'raw-file-section';

        const nameEl = document.createElement('div');
        nameEl.className = 'raw-file-name ' + (file.name.startsWith('human') ? 'human' : 'ai');
        nameEl.textContent = file.name;
        section.appendChild(nameEl);

        const contentEl = document.createElement('pre');
        contentEl.className = 'raw-file-content';
        contentEl.textContent = file.content;
        section.appendChild(contentEl);

        return section;
    }

    private closeRawFilesPopup(): void {
        if (this.rawFilesRefreshTimer) {
            clearInterval(this.rawFilesRefreshTimer);
            this.rawFilesRefreshTimer = 0;
        }
        if (this.rawFilesOverlay) {
            this.rawFilesOverlay.remove();
            this.rawFilesOverlay = null;
            this.rawFilesContainer = null;
        }
    }

    // ── TODO panel ──────────────────────────────────────────────────

    private renderTodoPanel(todos: string[], currentIndex: number): void {
        if (this.todoPanel) this.todoPanel.remove();
        this.todoTexts = todos;

        if (todos.length === 0) {
            this.todoPanel = null;
            this.todoItems = [];
            return;
        }

        this.todoPanel = document.createElement('div');
        this.todoPanel.className = 'todo-panel';

        const header = document.createElement('div');
        header.className = 'todo-header';

        const title = document.createElement('span');
        title.className = 'todo-title';
        title.textContent = t('chat.buildingPlan');
        header.appendChild(title);

        const status = document.createElement('span');
        status.className = 'todo-status';
        status.textContent = `0 / ${todos.length}`;
        header.appendChild(status);

        this.todoPanel.appendChild(header);

        this.todoItems = [];
        for (let i = 0; i < todos.length; i++) {
            const item = document.createElement('div');
            item.className = 'todo-item' + (i === currentIndex ? ' todo-active' : '');

            const check = document.createElement('span');
            check.className = 'todo-check';
            check.textContent = '\u25CB';
            item.appendChild(check);

            const text = document.createElement('span');
            text.className = 'todo-text';
            text.textContent = todos[i];
            item.appendChild(text);

            this.todoPanel.appendChild(item);
            this.todoItems.push(item);
        }

        this.el.insertBefore(this.todoPanel, this.messagesContainer);
    }

    private markTodoDone(index: number): void {
        if (!this.todoPanel) return;

        const item = this.todoItems[index];
        if (item) {
            item.classList.remove('todo-active');
            item.classList.add('todo-done');
            const check = item.querySelector('.todo-check');
            if (check) check.textContent = '\u2713';
        }

        const next = this.todoItems[index + 1];
        if (next) next.classList.add('todo-active');

        const done = this.todoItems.filter(el => el.classList.contains('todo-done')).length;
        const status = this.todoPanel.querySelector('.todo-status');
        if (status) status.textContent = `${done} / ${this.todoItems.length}`;
    }

    private markAllTodosDone(): void {
        if (!this.todoPanel) return;

        for (const item of this.todoItems) {
            item.classList.remove('todo-active');
            item.classList.add('todo-done');
            const check = item.querySelector('.todo-check');
            if (check) check.textContent = '\u2713';
        }

        const status = this.todoPanel.querySelector('.todo-status');
        if (status) status.textContent = `${this.todoItems.length} / ${this.todoItems.length} \u2713`;

        const header = this.todoPanel.querySelector('.todo-header') as HTMLElement;
        if (header) header.style.color = '#4ade80';

        const panel = this.todoPanel;
        setTimeout(() => {
            panel.style.transition = 'opacity 0.5s ease';
            panel.style.opacity = '0';
            setTimeout(() => {
                panel.remove();
                if (this.todoPanel === panel) {
                    this.todoPanel = null;
                    this.todoItems = [];
                }
            }, 500);
        }, 2000);
    }
}
