/**
 * Animation state machine that drives transitions based on parameters.
 *
 * Supports:
 * - States with associated clips
 * - Transitions with conditions (float, int, bool, trigger)
 * - Blend trees (1D and 2D) for smooth blending between animations
 * - Exit time support for auto-transitioning at clip end
 */

export interface AnimState {
    name: string;
    clip: string;
    speed: number;
    loop: boolean;
    blendTree?: BlendTree;
}

export interface AnimTransition {
    from: string;
    to: string;
    conditions: TransitionCondition[];
    blendDuration: number;
    hasExitTime: boolean;
    /** Normalized exit time (0..1) at which transition can begin. */
    exitTime: number;
}

export interface TransitionCondition {
    param: string;
    type: 'float' | 'int' | 'bool' | 'trigger';
    comparison: 'greater' | 'less' | 'equal' | 'notEqual';
    threshold: number;
}

export interface BlendTree {
    type: '1d' | '2d';
    blendParam: string;
    blendParam2?: string;
    entries: BlendTreeEntry[];
}

export interface BlendTreeEntry {
    clip: string;
    /** Threshold value for 1D blending. */
    threshold: number;
    /** Position in 2D blend space. */
    position?: { x: number; y: number };
    /** Current weight (computed at runtime). */
    weight: number;
}

export class AnimationStateMachine {
    private states: Map<string, AnimState> = new Map();
    private transitions: AnimTransition[] = [];
    private parameters: Map<string, { type: string; value: number | boolean }> = new Map();

    currentState: string = '';
    currentTime: number = 0;

    private transitionTarget: string = '';
    private transitionBlendTime: number = 0;
    private transitionElapsed: number = 0;
    private isTransitioning: boolean = false;
    private entryState: string = '';

    // -- State Management --

    addState(name: string, config: { clip?: string; speed?: number; loop?: boolean; blendTree?: BlendTree }): void {
        const state: AnimState = {
            name,
            clip: config.clip ?? '',
            speed: config.speed ?? 1.0,
            loop: config.loop ?? true,
            blendTree: config.blendTree,
        };
        this.states.set(name, state);

        if (!this.entryState) {
            this.entryState = name;
            this.currentState = name;
        }
    }

    removeState(name: string): void {
        this.states.delete(name);
        this.transitions = this.transitions.filter(t => t.from !== name && t.to !== name);
    }

    // -- Transitions --

    addTransition(
        from: string,
        to: string,
        conditions: TransitionCondition[],
        blendDuration: number = 0.2,
        hasExitTime: boolean = false,
        exitTime: number = 1.0,
    ): void {
        this.transitions.push({ from, to, conditions, blendDuration, hasExitTime, exitTime });
    }

    // -- Parameters --

    setFloat(name: string, value: number): void {
        this.parameters.set(name, { type: 'float', value });
    }

    setInt(name: string, value: number): void {
        this.parameters.set(name, { type: 'int', value: Math.floor(value) });
    }

    setBool(name: string, value: boolean): void {
        this.parameters.set(name, { type: 'bool', value });
    }

    setTrigger(name: string): void {
        this.parameters.set(name, { type: 'trigger', value: true });
    }

    resetTrigger(name: string): void {
        const param = this.parameters.get(name);
        if (param && param.type === 'trigger') param.value = false;
    }

    getFloat(name: string): number {
        return (this.parameters.get(name)?.value as number) ?? 0;
    }

    getBool(name: string): boolean {
        return (this.parameters.get(name)?.value as boolean) ?? false;
    }

    // -- Update --

    /**
     * Advance the state machine by deltaTime.
     * Returns current animation state for the animator to consume.
     */
    update(deltaTime: number): AnimationPlaybackInfo {
        const state = this.states.get(this.currentState);
        if (!state) {
            return { clip: '', time: 0, speed: 1, loop: true, blendClip: '', blendFactor: 0 };
        }

        this.currentTime += deltaTime * state.speed;

        // Check transitions
        if (!this.isTransitioning) {
            for (const transition of this.transitions) {
                if (transition.from !== this.currentState) continue;
                if (!this.checkConditions(transition.conditions)) continue;

                if (transition.hasExitTime) {
                    const normalized = state.loop ? (this.currentTime % 1) : Math.min(this.currentTime, 1);
                    if (normalized < transition.exitTime) continue;
                }

                this.transitionTarget = transition.to;
                this.transitionBlendTime = transition.blendDuration;
                this.transitionElapsed = 0;
                this.isTransitioning = true;

                // Consume triggers
                for (const cond of transition.conditions) {
                    if (cond.type === 'trigger') {
                        this.resetTrigger(cond.param);
                    }
                }
                break;
            }
        }

        // Process active transition
        let blendClip = '';
        let blendFactor = 0;

        if (this.isTransitioning) {
            this.transitionElapsed += deltaTime;
            blendFactor = this.transitionBlendTime > 0
                ? Math.min(this.transitionElapsed / this.transitionBlendTime, 1)
                : 1;

            const targetState = this.states.get(this.transitionTarget);
            blendClip = targetState?.clip ?? '';

            if (blendFactor >= 1) {
                this.currentState = this.transitionTarget;
                this.currentTime = this.transitionElapsed;
                this.isTransitioning = false;
                this.transitionTarget = '';
            }
        }

        if (state.blendTree) {
            this.updateBlendTree(state.blendTree);
        }

        return {
            clip: state.clip,
            time: this.currentTime,
            speed: state.speed,
            loop: state.loop,
            blendClip,
            blendFactor,
            blendTree: state.blendTree,
        };
    }

    private checkConditions(conditions: TransitionCondition[]): boolean {
        for (const cond of conditions) {
            const param = this.parameters.get(cond.param);
            if (!param) return false;

            const value = param.value;

            switch (cond.type) {
                case 'trigger':
                    if (!value) return false;
                    break;
                case 'bool':
                    if (cond.comparison === 'equal' && value !== (cond.threshold !== 0)) return false;
                    if (cond.comparison === 'notEqual' && value === (cond.threshold !== 0)) return false;
                    break;
                case 'float':
                case 'int': {
                    const numVal = value as number;
                    switch (cond.comparison) {
                        case 'greater': if (numVal <= cond.threshold) return false; break;
                        case 'less': if (numVal >= cond.threshold) return false; break;
                        case 'equal': if (Math.abs(numVal - cond.threshold) > 0.001) return false; break;
                        case 'notEqual': if (Math.abs(numVal - cond.threshold) <= 0.001) return false; break;
                    }
                    break;
                }
            }
        }
        return true;
    }

    private updateBlendTree(tree: BlendTree): void {
        if (tree.type === '1d') {
            const paramValue = this.getFloat(tree.blendParam);
            this.compute1DBlendWeights(tree.entries, paramValue);
        } else if (tree.type === '2d') {
            const paramX = this.getFloat(tree.blendParam);
            const paramY = this.getFloat(tree.blendParam2 ?? '');
            this.compute2DBlendWeights(tree.entries, paramX, paramY);
        }
    }

    private compute1DBlendWeights(entries: BlendTreeEntry[], value: number): void {
        const sorted = [...entries].sort((a, b) => a.threshold - b.threshold);

        for (const entry of entries) entry.weight = 0;

        if (sorted.length === 0) return;
        if (sorted.length === 1) { sorted[0].weight = 1; return; }

        if (value <= sorted[0].threshold) { sorted[0].weight = 1; return; }
        if (value >= sorted[sorted.length - 1].threshold) { sorted[sorted.length - 1].weight = 1; return; }

        for (let i = 0; i < sorted.length - 1; i++) {
            if (value >= sorted[i].threshold && value <= sorted[i + 1].threshold) {
                const range = sorted[i + 1].threshold - sorted[i].threshold;
                const t = range > 0 ? (value - sorted[i].threshold) / range : 0;
                sorted[i].weight = 1 - t;
                sorted[i + 1].weight = t;
                return;
            }
        }
    }

    private compute2DBlendWeights(entries: BlendTreeEntry[], x: number, y: number): void {
        let totalWeight = 0;
        for (const entry of entries) {
            const pos = entry.position ?? { x: 0, y: 0 };
            const dx = x - pos.x;
            const dy = y - pos.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            entry.weight = dist < 0.001 ? 1000 : 1 / dist;
            totalWeight += entry.weight;
        }

        if (totalWeight > 0) {
            for (const entry of entries) {
                entry.weight /= totalWeight;
            }
        }
    }

    // -- State query --

    getCurrentStateName(): string {
        return this.currentState;
    }

    getState(name: string): AnimState | undefined {
        return this.states.get(name);
    }

    getAllStates(): AnimState[] {
        return Array.from(this.states.values());
    }

    isInTransition(): boolean {
        return this.isTransitioning;
    }

    // -- Serialization --

    toJSON(): Record<string, any> {
        return {
            states: Array.from(this.states.values()),
            transitions: this.transitions,
            parameters: Array.from(this.parameters.entries()).map(([k, v]) => ({
                name: k, type: v.type, value: v.value,
            })),
            entryState: this.entryState,
        };
    }

    static fromJSON(data: Record<string, any>): AnimationStateMachine {
        const sm = new AnimationStateMachine();
        if (Array.isArray(data.states)) {
            for (const s of data.states) {
                sm.addState(s.name, s);
            }
        }
        if (Array.isArray(data.transitions)) {
            for (const t of data.transitions) {
                sm.addTransition(t.from, t.to, t.conditions, t.blendDuration, t.hasExitTime, t.exitTime);
            }
        }
        if (Array.isArray(data.parameters)) {
            for (const p of data.parameters) {
                sm.parameters.set(p.name, { type: p.type, value: p.value });
            }
        }
        if (data.entryState) {
            sm.entryState = data.entryState;
            sm.currentState = data.entryState;
        }
        return sm;
    }
}

export interface AnimationPlaybackInfo {
    clip: string;
    time: number;
    speed: number;
    loop: boolean;
    blendClip: string;
    blendFactor: number;
    blendTree?: BlendTree;
}
