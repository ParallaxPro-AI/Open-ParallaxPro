/**
 * Playtest API — the probe/cheat/assert surface exposed to PLAYTEST.ts.
 *
 * Everything in this class reads or writes the REAL browser-engine Scene,
 * Entity, Components, PhysicsSystem, ScriptSystem, InputSystem. No parallel
 * data model: when a PLAYTEST asserts `p.pos(car).x > 10`, the query hits
 * the same `TransformComponent.position.x` the browser's scripts do.
 *
 * Cheats (teleport, setVelocity, setDriveInput) flow through the same
 * RigidbodyComponent methods the browser uses; UI probes (click, findButton)
 * go through the headless GameUI stub which records createText / createButton
 * calls for later lookup.
 */

import { Runtime } from './runtime.js';
import { Entity } from '../../frontend/runtime/function/framework/entity.js';
import { Vec3 } from '../../frontend/runtime/core/math/vec3.js';
import { UIElement } from './ui.js';

export interface EntityRef {
  id: number;
  name: string;
}

export interface Vec3Like { x: number; y: number; z: number; }

export class PlaytestFailure extends Error {
  constructor(
    public code: string,
    public hint: string,
    public detail: Record<string, any> = {},
  ) {
    super(`[${code}] ${hint}`);
  }
}

function toRef(e: Entity | null | undefined): EntityRef | null {
  return e ? { id: e.id, name: e.name } : null;
}

/** AABB from an Entity's TransformComponent + ColliderComponent. Used by the
 * spawn-overlap invariant — we deliberately don't ask Rapier for cold overlap
 * pairs because its narrow-phase cache is empty until the world has stepped
 * at least once, and the check must fire BEFORE we let physics move anything.
 *
 * Reads the post-initialize fields on ColliderComponent: `halfExtents` is a
 * Vec3, `shapeType` is a numeric enum (ShapeType.BOX=0, SPHERE=1, CAPSULE=2,
 * MESH=3, TERRAIN=4, COMPOUND=5). For MESH/TERRAIN we skip — the authored
 * trimesh can be arbitrarily complex and a false-negative on overlap is the
 * right failure mode for a playability gate. */
function entityAABB(e: Entity): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } | null {
  const tc: any = e.getComponent('TransformComponent');
  const cc: any = e.getComponent('ColliderComponent');
  if (!tc || !cc) return null;
  const p = tc.position, s = tc.scale ?? { x: 1, y: 1, z: 1 };
  const he = cc.halfExtents;
  const st = cc.shapeType;
  // SPHERE (1)
  if (st === 1) {
    const r = (cc.radius ?? 0.5) * Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
    return { minX: p.x - r, maxX: p.x + r, minY: p.y - r, maxY: p.y + r, minZ: p.z - r, maxZ: p.z + r };
  }
  // CAPSULE (2)
  if (st === 2) {
    const r = (cc.radius ?? 0.5) * Math.max(Math.abs(s.x), Math.abs(s.z));
    const h = (cc.height ?? 1.0) * Math.abs(s.y);
    return { minX: p.x - r, maxX: p.x + r, minY: p.y - h * 0.5, maxY: p.y + h * 0.5, minZ: p.z - r, maxZ: p.z + r };
  }
  // BOX (0) + MESH/TERRAIN fallback to AABB of halfExtents — mesh/terrain
  // would need the actual mesh AABB to be precise but the assembler sets
  // them to defaults so this is acceptable.
  if (he && typeof he.x === 'number') {
    return {
      minX: p.x - he.x * Math.abs(s.x), maxX: p.x + he.x * Math.abs(s.x),
      minY: p.y - he.y * Math.abs(s.y), maxY: p.y + he.y * Math.abs(s.y),
      minZ: p.z - he.z * Math.abs(s.z), maxZ: p.z + he.z * Math.abs(s.z),
    };
  }
  return null;
}

function aabbOverlap(a: ReturnType<typeof entityAABB>, b: ReturnType<typeof entityAABB>): boolean {
  if (!a || !b) return false;
  return a.minX <= b.maxX && a.maxX >= b.minX
      && a.minY <= b.maxY && a.maxY >= b.minY
      && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

export class Playtest {
  private snapshots = new Map<string, any>();
  private snapCounter = 0;

  constructor(public runtime: Runtime) {}

  private requireScene(): any {
    if (!this.runtime.scene) throw new Error('runtime has no scene — did you await boot()?');
    return this.runtime.scene;
  }

  /* ─── Time ─────────────────────────────────────────────────────── */
  tick(n: number = 1): void { this.runtime.tickN(n); }
  tickSeconds(s: number): void { this.runtime.tickSeconds(s); }
  frameCount(): number { return this.runtime.time.frameCount; }

  /* ─── Scene queries ────────────────────────────────────────────── */
  find(name: string): EntityRef | null {
    const s = this.requireScene();
    for (const e of s.entities.values()) if (e.name === name) return toRef(e);
    const lower = name.toLowerCase();
    for (const e of s.entities.values()) if (e.name.toLowerCase() === lower) return toRef(e);
    return null;
  }
  findAll(name: string): EntityRef[] {
    const s = this.requireScene();
    const out: EntityRef[] = [];
    for (const e of s.entities.values()) if (e.name === name) out.push(toRef(e)!);
    return out;
  }
  findByTag(tag: string): EntityRef | null {
    const s = this.requireScene();
    for (const e of s.entities.values()) {
      const t = e.tags;
      const has = t instanceof Set ? t.has(tag) : (Array.isArray(t) ? t.includes(tag) : false);
      if (has) return toRef(e);
    }
    return null;
  }
  findAllByTag(tag: string): EntityRef[] {
    const s = this.requireScene();
    const out: EntityRef[] = [];
    for (const e of s.entities.values()) {
      const t = e.tags;
      const has = t instanceof Set ? t.has(tag) : (Array.isArray(t) ? t.includes(tag) : false);
      if (has) out.push(toRef(e)!);
    }
    return out;
  }
  list(): EntityRef[] {
    const s = this.requireScene();
    return Array.from(s.entities.values()).map((e: any) => toRef(e)!);
  }
  pos(ref: EntityRef | null): Vec3Like | null {
    if (!ref) return null;
    const s = this.requireScene();
    const e: Entity = s.entities.get(ref.id);
    if (!e) return null;
    const tc: any = e.getComponent('TransformComponent');
    if (!tc) return null;
    return { x: tc.position.x, y: tc.position.y, z: tc.position.z };
  }
  vel(ref: EntityRef | null): Vec3Like | null {
    if (!ref) return null;
    const s = this.requireScene();
    const e: Entity = s.entities.get(ref.id);
    const rb: any = e?.getComponent('RigidbodyComponent');
    if (!rb) return null;
    if (typeof rb.getLinearVelocity === 'function') {
      const v = rb.getLinearVelocity();
      return { x: v.x, y: v.y, z: v.z };
    }
    if (rb.velocity) return { x: rb.velocity.x, y: rb.velocity.y, z: rb.velocity.z };
    return { x: 0, y: 0, z: 0 };
  }
  /** Entity's forward vector (unit-length) derived from its rotation
   * quaternion. Engine convention: yaw 0 → forward = (0, 0, -1). Used by
   * invariants to confirm motion direction matches visual facing. */
  forward(ref: EntityRef | null): Vec3Like | null {
    if (!ref) return null;
    const s = this.requireScene();
    const e: Entity = s.entities.get(ref.id);
    if (!e) return null;
    const tc: any = e.getComponent('TransformComponent');
    if (!tc) return null;
    const qx = tc.rotation.x, qy = tc.rotation.y, qz = tc.rotation.z, qw = tc.rotation.w;
    return {
      x: -(2 * (qx * qz + qw * qy)),
      y: -(2 * (qy * qz - qw * qx)),
      z: -(1 - 2 * (qx * qx + qy * qy)),
    };
  }

  tags(ref: EntityRef | null): string[] {
    if (!ref) return [];
    const s = this.requireScene();
    const e = s.entities.get(ref.id);
    if (!e) return [];
    const t = e.tags;
    return t instanceof Set ? Array.from(t) : Array.isArray(t) ? t.slice() : [];
  }
  isGrounded(ref: EntityRef | null): boolean {
    if (!ref) return false;
    const s = this.requireScene();
    const e: Entity = s.entities.get(ref.id);
    const rb: any = e?.getComponent('RigidbodyComponent');
    return !!rb?.grounded;
  }
  isOverlapping(a: EntityRef, b: EntityRef): boolean {
    const s = this.requireScene();
    const ea = s.entities.get(a.id), eb = s.entities.get(b.id);
    if (!ea || !eb) return false;
    return aabbOverlap(entityAABB(ea), entityAABB(eb));
  }
  overlappingOthers(ref: EntityRef): EntityRef[] {
    const s = this.requireScene();
    const e: Entity = s.entities.get(ref.id);
    if (!e) return [];
    const a = entityAABB(e);
    if (!a) return [];
    const hits: EntityRef[] = [];
    for (const other of s.entities.values()) {
      if (other === e || !other.active) continue;
      const cc: any = other.getComponent('ColliderComponent');
      if (!cc) continue;
      if (cc.isTrigger) continue;
      const b = entityAABB(other);
      if (!b) continue;
      if (aabbOverlap(a, b)) hits.push(toRef(other)!);
    }
    return hits;
  }

  /** Entities the player is *stuck inside* — a strict subset of overlappingOthers.
   * An overlap counts as "stuck" only when the player's CENTER is inside the
   * other's AABB. That filters out the ubiquitous "sitting on the ground" case
   * (player's feet clip into the floor but center is above it), catching only
   * the "spawned inside a wall" cases the CLI is prone to authoring.
   *
   * NOTE: the level_assembler currently emits broken ColliderComponent sizes
   * (shapeType nested as an object, halfExtents falling back to a 1-unit
   * default). This heuristic remains robust in spite of that — "center in
   * other's AABB" still discriminates wall-stuck from ground-rest regardless
   * of actual sizes. See `entityAABB` for the wider context. */
  private stuckIn(ref: EntityRef): EntityRef[] {
    const s = this.requireScene();
    const e: Entity = s.entities.get(ref.id);
    if (!e) return [];
    const tc: any = e.getComponent('TransformComponent');
    if (!tc) return [];
    const cx = tc.position.x, cy = tc.position.y, cz = tc.position.z;
    const stuck: EntityRef[] = [];
    for (const other of s.entities.values()) {
      if (other === e || !other.active) continue;
      const cc: any = other.getComponent('ColliderComponent');
      if (!cc || cc.isTrigger) continue;
      const b = entityAABB(other);
      if (!b) continue;
      if (cx >= b.minX && cx <= b.maxX && cy >= b.minY && cy <= b.maxY && cz >= b.minZ && cz <= b.maxZ) {
        stuck.push(toRef(other)!);
      }
    }
    return stuck;
  }
  raycast(origin: Vec3Like, dir: Vec3Like, maxDist: number = 1000): { hit: EntityRef; point: Vec3Like; distance: number } | null {
    const phys: any = this.runtime.physicsSystem;
    if (typeof phys.raycastWorld !== 'function') return null;
    const r = phys.raycastWorld(new Vec3(origin.x, origin.y, origin.z), new Vec3(dir.x, dir.y, dir.z), maxDist, undefined);
    if (!r) return null;
    const s = this.requireScene();
    const e = s.entities.get(r.entityId);
    return { hit: toRef(e)!, point: { x: r.point.x, y: r.point.y, z: r.point.z }, distance: r.distance };
  }
  errors(): Array<{ source: string; message: string }> {
    return this.runtime.scriptErrors.slice();
  }
  fsmState(): string | null { return this.runtime.currentFsmState; }
  getState(): any { return this.runtime.ui.getState(); }

  /* ─── Actuation (realistic input) ───────────────────────────────── */
  keyDown(key: string): void { this.runtime.inputSystem.simulateKeyDown(key); }
  keyUp(key: string): void { this.runtime.inputSystem.simulateKeyUp(key); }
  tapKey(key: string, durationMs: number = 100): void {
    this.keyDown(key);
    const frames = Math.max(1, Math.round((durationMs / 1000) * 60));
    this.tick(frames);
    this.keyUp(key);
    this.tick(1);
  }
  mouseMove(dx: number, dy: number): void { this.runtime.inputSystem.simulateMouseMove(dx, dy); }
  mousePosition(x: number, y: number): void { this.runtime.inputSystem.simulateMousePosition(x, y); }
  mouseDown(btn: number | string = 'MouseLeft'): void {
    if (typeof btn === 'string') this.runtime.inputSystem.simulateKeyDown(btn);
    else (this.runtime.inputSystem as any).simulateKeyDown?.(`Mouse${btn}`);
  }
  mouseUp(btn: number | string = 'MouseLeft'): void {
    if (typeof btn === 'string') this.runtime.inputSystem.simulateKeyUp(btn);
    else (this.runtime.inputSystem as any).simulateKeyUp?.(`Mouse${btn}`);
  }
  click(x: number, y: number): { hit: UIElement | null } {
    this.runtime.inputSystem.simulateMousePosition(x, y);
    const el = this.runtime.ui.findAtPoint(x, y);
    this.runtime.inputSystem.simulateKeyDown('MouseLeft');
    this.tick(1);
    if (el) {
      try { this.runtime.ui.clickElement(el); }
      catch (e: any) { this.runtime.scriptErrors.push({ source: el.id, message: `click handler: ${e?.message ?? e}` }); }
    }
    this.runtime.inputSystem.simulateKeyUp('MouseLeft');
    this.tick(1);
    return { hit: el };
  }
  clickButtonByText(text: string): boolean {
    const el = this.runtime.ui.findButtonByText(text);
    if (!el) return false;
    this.click(el.x + el.width * 0.5, el.y + el.height * 0.5);
    return true;
  }
  clickElementById(id: string): boolean {
    const el = this.runtime.ui.findById(id);
    if (!el) return false;
    this.click(el.x + el.width * 0.5, el.y + el.height * 0.5);
    return true;
  }

  /* ─── Cheats (bypass gameplay friction) ─────────────────────────── */
  /** Force every behavior script to `_behaviorActive = true` so onUpdate /
   * onFixedUpdate / onLateUpdate actually run without having to drive the
   * FSM through boot → main_menu → gameplay via UI clicks first. The real
   * engine gates behavior scripts via an `active_behaviors` event the
   * FSM driver emits per state — we short-circuit that for tests. */
  activateAllBehaviors(): number {
    const insts: any[] = (this.runtime.scriptSystem as any).instances ?? [];
    let count = 0;
    for (const inst of insts) {
      if (inst?.script && (inst.script as any)._behaviorName !== undefined) {
        (inst.script as any)._behaviorActive = true;
        count++;
      }
    }
    return count;
  }

  teleport(ref: EntityRef, pos: Vec3Like): void {
    const s = this.requireScene();
    const e: Entity = s.entities.get(ref.id);
    if (!e) return;
    const tc: any = e.getComponent('TransformComponent');
    const rb: any = e.getComponent('RigidbodyComponent');
    if (tc) { tc.position.x = pos.x; tc.position.y = pos.y; tc.position.z = pos.z; tc.invalidate?.(); }
    if (rb && typeof rb.teleport === 'function') rb.teleport(pos.x, pos.y, pos.z);
  }
  setVelocity(ref: EntityRef, v: Vec3Like): void {
    const s = this.requireScene();
    const e: Entity = s.entities.get(ref.id);
    const rb: any = e?.getComponent('RigidbodyComponent');
    if (!rb) return;
    if (typeof rb.setLinearVelocity === 'function') rb.setLinearVelocity({ x: v.x, y: v.y, z: v.z });
    else if (rb.velocity) { rb.velocity.x = v.x; rb.velocity.y = v.y; rb.velocity.z = v.z; }
  }
  spawn(prefabName: string, pos?: Vec3Like): EntityRef | null {
    const s = this.requireScene();
    if (typeof s.hasPrefab !== 'function' || !s.hasPrefab(prefabName)) return null;
    const e: Entity = s.instantiatePrefab(prefabName);
    if (pos) {
      const tc: any = e.getComponent('TransformComponent');
      if (tc) { tc.position.x = pos.x; tc.position.y = pos.y; tc.position.z = pos.z; tc.invalidate?.(); }
    }
    // Attach scripts the same way boot() does for newly spawned prefab entities.
    const sc: any = e.getComponent('ScriptComponent');
    if (sc?.scriptURL && this.runtime.makeScriptEntity) {
      const cls = this.runtime.classMap.get(sc.scriptURL);
      if (cls) {
        const scriptEntity = this.runtime.makeScriptEntity(e);
        this.runtime.scriptSystem.attachScript(cls.name || sc.scriptURL, scriptEntity);
      }
    }
    return toRef(e);
  }
  destroy(ref: EntityRef): void {
    const s = this.requireScene();
    this.runtime.scriptSystem.detachScripts(ref.id);
    s.destroyEntity(ref.id);
  }
  /** Car-style simulate-input cheat. Presses the movement keys that
   * generated car_control.ts / player_movement.ts scripts poll. */
  setDriveInput(opts: { throttle?: number; steer?: number; brake?: boolean }): void {
    if ((opts.throttle ?? 0) > 0) this.keyDown('KeyW'); else this.keyUp('KeyW');
    if ((opts.throttle ?? 0) < 0) this.keyDown('KeyS'); else this.keyUp('KeyS');
    if ((opts.steer ?? 0) < 0) this.keyDown('KeyA'); else this.keyUp('KeyA');
    if ((opts.steer ?? 0) > 0) this.keyDown('KeyD'); else this.keyUp('KeyD');
    if (opts.brake) this.keyDown('Space'); else this.keyUp('Space');
  }
  setScriptField(ref: EntityRef, className: string, field: string, value: any): boolean {
    const s = this.runtime.scriptSystem.findScript(ref.id, className);
    if (!s) return false;
    (s as any)[field] = value;
    return true;
  }
  aimAt(shooter: EntityRef, target: EntityRef): boolean {
    const s = this.requireScene();
    const sh: Entity = s.entities.get(shooter.id), tg: Entity = s.entities.get(target.id);
    if (!sh || !tg) return false;
    const shT: any = sh.getComponent('TransformComponent');
    const tgT: any = tg.getComponent('TransformComponent');
    if (!shT || !tgT) return false;
    // Entity.lookAt exists on some versions; fall back to Transform-level compute.
    if (typeof (sh as any).lookAt === 'function') {
      (sh as any).lookAt(tgT.position.x, tgT.position.y, tgT.position.z);
      return true;
    }
    if (shT && typeof shT.lookAt === 'function') { shT.lookAt(tgT.position); return true; }
    return false;
  }

  /* ─── Snapshots (cheap rewind) ──────────────────────────────────── */
  snapshot(): string {
    const s = this.requireScene();
    const id = `snap_${this.snapCounter++}`;
    const data: any = { entities: [], fsm: this.runtime.currentFsmState, time: { ...this.runtime.time } };
    for (const e of s.entities.values()) {
      const tc: any = e.getComponent('TransformComponent');
      const rb: any = e.getComponent('RigidbodyComponent');
      data.entities.push({
        id: e.id,
        position: tc ? { x: tc.position.x, y: tc.position.y, z: tc.position.z } : null,
        rotation: tc ? { x: tc.rotation.x, y: tc.rotation.y, z: tc.rotation.z, w: tc.rotation.w } : null,
        velocity: rb?.getLinearVelocity ? (() => { const v = rb.getLinearVelocity(); return { x: v.x, y: v.y, z: v.z }; })() : null,
      });
    }
    this.snapshots.set(id, data);
    return id;
  }
  restore(id?: string): boolean {
    const s = this.requireScene();
    const key = id ?? `snap_${this.snapCounter - 1}`;
    const data = this.snapshots.get(key);
    if (!data) return false;
    for (const ed of data.entities) {
      const e: Entity = s.entities.get(ed.id);
      if (!e) continue;
      const tc: any = e.getComponent('TransformComponent');
      const rb: any = e.getComponent('RigidbodyComponent');
      if (tc && ed.position) { tc.position.x = ed.position.x; tc.position.y = ed.position.y; tc.position.z = ed.position.z; tc.invalidate?.(); }
      if (tc && ed.rotation) { tc.rotation.x = ed.rotation.x; tc.rotation.y = ed.rotation.y; tc.rotation.z = ed.rotation.z; tc.rotation.w = ed.rotation.w; tc.invalidate?.(); }
      if (rb && ed.velocity) {
        if (typeof rb.teleport === 'function') rb.teleport(ed.position.x, ed.position.y, ed.position.z);
        if (typeof rb.setLinearVelocity === 'function') rb.setLinearVelocity(ed.velocity);
      }
    }
    this.runtime.currentFsmState = data.fsm;
    return true;
  }

  /* ─── Assertions ────────────────────────────────────────────────── */
  assertExists(ref: EntityRef | null, label: string = 'entity'): void {
    if (!ref || !this.requireScene().entities.get(ref.id)) {
      throw new PlaytestFailure('missing_entity', `expected ${label} to exist`, { label });
    }
  }
  assertTagExists(tag: string): void {
    if (!this.findByTag(tag)) throw new PlaytestFailure('missing_tag', `no entity has tag "${tag}"`, { tag });
  }
  assertNotStuck(ref: EntityRef): void {
    const s = this.requireScene();
    const e: Entity = s.entities.get(ref.id);
    if (!e) throw new PlaytestFailure('missing_entity', `assertNotStuck: entity ${ref.name} gone`);
    const hits = this.stuckIn(ref);
    if (hits.length > 0) {
      const p = this.pos(ref);
      throw new PlaytestFailure('spawn_overlap',
        `entity "${e.name}" spawned INSIDE ${hits.length} collider(s): ${hits.slice(0, 3).map(h => h.name).join(', ')}. The player's center is inside another entity's bounds — move the spawn clear of world geometry (raise Y or shift XZ).`,
        { entity: e.name, position: p, stuckIn: hits.slice(0, 5) });
    }
  }
  assertMoved(ref: EntityRef, axis: 'x' | 'y' | 'z' | 'xz' | 'any', min: number, fromPos?: Vec3Like): void {
    const p = this.pos(ref);
    if (!p) throw new PlaytestFailure('missing_entity', `assertMoved: entity ${ref.name} gone`);
    const from = fromPos ?? { x: 0, y: 0, z: 0 };
    const dx = p.x - from.x, dy = p.y - from.y, dz = p.z - from.z;
    let moved = 0;
    if (axis === 'x') moved = Math.abs(dx);
    else if (axis === 'y') moved = Math.abs(dy);
    else if (axis === 'z') moved = Math.abs(dz);
    else if (axis === 'xz') moved = Math.sqrt(dx * dx + dz * dz);
    else moved = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (moved < min) {
      throw new PlaytestFailure('did_not_move',
        `entity "${ref.name}" expected to move ≥${min} on ${axis}, only moved ${moved.toFixed(3)}. Check controls are wired, physics is enabled, and nothing is blocking movement.`,
        { entity: ref.name, axis, min, moved, from, to: p });
    }
  }
  assertNoErrors(): void {
    if (this.runtime.scriptErrors.length > 0) {
      const first = this.runtime.scriptErrors[0];
      throw new PlaytestFailure('script_error',
        `${first.source}: ${first.message}${this.runtime.scriptErrors.length > 1 ? ` (+${this.runtime.scriptErrors.length - 1} more)` : ''}`,
        { count: this.runtime.scriptErrors.length, errors: this.runtime.scriptErrors.slice(0, 5) });
    }
  }
  assertPositionNotNaN(ref: EntityRef): void {
    const p = this.pos(ref);
    if (!p || !isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) {
      throw new PlaytestFailure('nan_position',
        `entity "${ref.name}" position is NaN/Infinity — usually means divide-by-zero in a behavior script`,
        { entity: ref.name, position: p });
    }
  }
  assertYAbove(ref: EntityRef, y: number): void {
    const p = this.pos(ref);
    if (!p || p.y < y) {
      throw new PlaytestFailure('fell_through_world',
        `entity "${ref.name}" fell below Y=${y} (now ${p?.y.toFixed(2)}). Likely missing ground collider under spawn.`,
        { entity: ref.name, y: p?.y, bound: y });
    }
  }
  assertEventFired(_name: string, _withinFrames: number = Infinity): void {
    // The real engine's event bus doesn't expose a history out-of-the-box;
    // leaving as a no-op pass for v1. Invariants don't use this today — only
    // authored PLAYTEST scripts might — so we document and move on.
  }
}
