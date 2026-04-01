/**
 * Game event definitions — single source of truth for the `game` event bus.
 * Each event has a name and a payload schema.
 * All event names must be snake_case.
 *
 * Payload field types: 'number', 'string', 'boolean', 'any'
 * Fields marked optional: true are not required.
 */
export const GAME_EVENTS: Record<string, { fields: Record<string, { type: string; optional?: boolean }> }> = {
    // ── Lifecycle ──
    active_systems:     { fields: { systems: { type: 'any' } } },
    active_behaviors:   { fields: { behaviors: { type: 'any' } } },
    state_changed:      { fields: {} },
    game_ready:         { fields: {} },
    game_over:          { fields: { score: { type: 'number', optional: true } } },
    game_won:           { fields: { score: { type: 'number', optional: true } } },
    resume_game:        { fields: {} },

    // ── Player ──
    player_died:        { fields: {} },
    player_respawned:   { fields: {} },
    player_action:      { fields: { action: { type: 'string', optional: true } } },
    player_entered_vehicle: { fields: { vehicleId: { type: 'number', optional: true } } },
    player_exited_vehicle:  { fields: {} },

    // ── Entity ──
    entity_damaged:     { fields: { entityId: { type: 'number' }, amount: { type: 'number' }, source: { type: 'string', optional: true } } },
    entity_killed:      { fields: { entityId: { type: 'number', optional: true } } },
    entity_healed:      { fields: { entityId: { type: 'number', optional: true }, amount: { type: 'number' } } },
    entity_destroyed:   { fields: { entityId: { type: 'number' } } },
    entity_spawned:     { fields: { entityId: { type: 'number', optional: true } } },
    entity_respawned:   { fields: {} },
    health_changed:     { fields: { health: { type: 'number' }, maxHealth: { type: 'number', optional: true } } },
    invincible:         { fields: { entityId: { type: 'number', optional: true }, duration: { type: 'number', optional: true } } },

    // ── Combat ──
    weapon_fired:       { fields: { ammo: { type: 'number', optional: true }, reserve: { type: 'number', optional: true }, weapon: { type: 'string', optional: true } } },
    reload_complete:    { fields: { ammo: { type: 'number', optional: true } } },
    weapon_swapped:     { fields: { weapon: { type: 'string' } } },
    weapon_purchased:   { fields: { weapon: { type: 'string', optional: true } } },
    projectile_hit:     { fields: { entityId: { type: 'number' }, damage: { type: 'number', optional: true } } },
    melee_hit:          { fields: { entityId: { type: 'number' }, damage: { type: 'number', optional: true } } },
    melee_swing:        { fields: {} },
    dodge_roll:         { fields: {} },
    spell_cast:         { fields: { spell: { type: 'string', optional: true } } },

    // ── Scoring ──
    add_score:          { fields: { amount: { type: 'number' } } },
    score_changed:      { fields: { score: { type: 'number' } } },
    lives_changed:      { fields: { lives: { type: 'number' } } },
    life_lost:          { fields: {} },

    // ── Waves / Rounds ──
    wave_started:       { fields: { wave: { type: 'number', optional: true } } },
    new_round:          { fields: { round: { type: 'number', optional: true } } },

    // ── Timer ──
    timer_update:       { fields: { time: { type: 'number' } } },

    // ── Items / Inventory ──
    item_used:          { fields: { item: { type: 'string', optional: true } } },
    item_pickup:        { fields: { item: { type: 'string', optional: true } } },
    pickup_collected:   { fields: { entityId: { type: 'number', optional: true } } },
    use_item:           { fields: { item: { type: 'string', optional: true } } },
    add_item:           { fields: { item: { type: 'string' } } },
    remove_item:        { fields: { item: { type: 'string' } } },
    inventory_changed:  { fields: {} },

    // ── Economy ──
    money_earned:       { fields: { amount: { type: 'number' } } },
    add_currency:       { fields: { amount: { type: 'number' } } },
    spend_currency:     { fields: { amount: { type: 'number' } } },
    buy_item:           { fields: { item: { type: 'string', optional: true } } },

    // ── Vehicle ──
    vehicle_entered:    { fields: { vehicleId: { type: 'number', optional: true } } },
    vehicle_exited:     { fields: {} },

    // ── AI ──
    spawn_enemy:        { fields: { count: { type: 'number', optional: true } } },
    ai_turn:            { fields: {} },

    // ── Chess ──
    chess_move_made:    { fields: { from: { type: 'any', optional: true }, to: { type: 'any', optional: true }, piece: { type: 'string', optional: true } } },
    apply_remote_move:  { fields: { from: { type: 'any' }, to: { type: 'any' }, color: { type: 'string', optional: true } } },
    move_made:          { fields: {} },

    // ── Racing ──
    race_start:         { fields: {} },
    race_started:       { fields: {} },
    race_finished:      { fields: {} },
    boost_active:       { fields: {} },
    speed_boost:        { fields: {} },

    // ── MOBA ──
    champion_died:      { fields: {} },
    minion_killed:      { fields: {} },
    ability_used:       { fields: {} },
    hero_selected:      { fields: { hero: { type: 'string', optional: true } } },
    hero_locked_in:     { fields: { hero: { type: 'string', optional: true } } },

    // ── Open world ──
    crime_committed:    { fields: {} },
    wanted_level_changed: { fields: { level: { type: 'number', optional: true } } },
    day_night_changed:  { fields: { time: { type: 'number', optional: true } } },
    mission_started:    { fields: { mission: { type: 'string', optional: true } } },
    mission_completed:  { fields: {} },
    npc_interaction:    { fields: { npcId: { type: 'number', optional: true } } },

    // ── Camera ──
    set_camera_yaw:     { fields: { yaw: { type: 'number' } } },

    // ── Cards ──
    card_played:        { fields: { card: { type: 'string', optional: true } } },

    // ── Flow transitions ──
    character_selected: { fields: {} },
    cutscene_complete:  { fields: {} },
    cutscene_started:   { fields: {} },
    draft_complete:     { fields: {} },
    load_complete:      { fields: {} },
    mission_failed:     { fields: {} },
    nexus_destroyed:    { fields: {} },
    player_nexus_destroyed: { fields: {} },
    checkmate:          { fields: {} },
    stalemate:          { fields: {} },
    dialogue_choice:    { fields: { choice: { type: 'string', optional: true } } },
};

export const VALID_GAME_EVENTS = new Set(Object.keys(GAME_EVENTS));
