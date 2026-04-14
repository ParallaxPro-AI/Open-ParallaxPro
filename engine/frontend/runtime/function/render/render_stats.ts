/**
 * Per-frame render counter bag. Owned by RenderPipeline, passed to every
 * pass so they can bump their own draw/triangle counts at each drawIndexed
 * or draw site. Reset once per frame at the top of RenderPipeline.render().
 */
export class RenderStats {
    drawCalls = 0;
    triangles = 0;
    /** Number of distinct mesh instances the geometry pass drew (post-cull). */
    meshesRendered = 0;
    /** Total mesh instances known to the render scene for this frame. */
    meshesTotal = 0;

    reset(): void {
        this.drawCalls = 0;
        this.triangles = 0;
        this.meshesRendered = 0;
        this.meshesTotal = 0;
    }

    /** Bump for one drawIndexed / draw call. `triangles` should be indexCount/3. */
    addDraw(triangles: number): void {
        this.drawCalls++;
        this.triangles += triangles;
    }

    addMeshRendered(): void {
        this.meshesRendered++;
    }

    snapshot(): { drawCalls: number; triangles: number; meshesRendered: number; meshesTotal: number } {
        return {
            drawCalls: this.drawCalls,
            triangles: this.triangles,
            meshesRendered: this.meshesRendered,
            meshesTotal: this.meshesTotal,
        };
    }
}
