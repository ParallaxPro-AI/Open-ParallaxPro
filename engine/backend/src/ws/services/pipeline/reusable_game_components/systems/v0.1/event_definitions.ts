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
    spend_resources:    { fields: { minerals: { type: 'number', optional: true }, gas: { type: 'number', optional: true } } },
    train_unit:         { fields: { unitType: { type: 'string', optional: true }, x: { type: 'number', optional: true }, z: { type: 'number', optional: true } } },
    accept_quest:       { fields: { questId: { type: 'string', optional: true } } },

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

    // ── Racing / Endless Runner ──
    race_start:         { fields: {} },
    race_started:       { fields: {} },
    race_finished:      { fields: {} },
    boost_active:       { fields: {} },
    speed_boost:        { fields: {} },
    runner_crash:       { fields: {} },
    restart_game:       { fields: {} },
    tank_fired:         { fields: { x: { type: 'number', optional: true }, z: { type: 'number', optional: true }, yaw: { type: 'number', optional: true }, damage: { type: 'number', optional: true }, range: { type: 'number', optional: true }, source: { type: 'string', optional: true } } },
    player_repair:      { fields: { amount: { type: 'number', optional: true } } },
    battle_start:       { fields: {} },
    dash_start:         { fields: {} },
    dash_die:           { fields: {} },
    dash_reset:         { fields: {} },

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

    // ── Tower Defense ──
    tower_placed:       { fields: { towerId: { type: 'number', optional: true }, towerType: { type: 'string', optional: true } } },
    tower_upgraded:     { fields: { towerId: { type: 'number', optional: true }, level: { type: 'number', optional: true } } },
    tower_sold:         { fields: { towerId: { type: 'number', optional: true } } },
    wave_complete:      { fields: { wave: { type: 'number', optional: true } } },
    all_waves_complete: { fields: {} },
    enemy_reached_end:  { fields: { enemyId: { type: 'number', optional: true } } },

    // ── Platformer ──
    coin_collected:     { fields: { entityId: { type: 'number', optional: true } } },
    level_complete:     { fields: { level: { type: 'number', optional: true } } },
    checkpoint_reached: { fields: {} },
    player_fell:        { fields: {} },
    double_jump:        { fields: {} },
    wall_jump:          { fields: {} },

    // ── Survival / Crafting ──
    hunger_changed:     { fields: { hunger: { type: 'number' } } },
    thirst_changed:     { fields: { thirst: { type: 'number' } } },
    item_crafted:       { fields: { item: { type: 'string', optional: true } } },
    resource_gathered:  { fields: { resource: { type: 'string', optional: true }, amount: { type: 'number', optional: true } } },
    building_placed:    { fields: { building: { type: 'string', optional: true } } },
    building_destroyed: { fields: { buildingId: { type: 'number', optional: true } } },
    block_mined:        { fields: { entityId: { type: 'number', optional: true }, x: { type: 'number', optional: true }, y: { type: 'number', optional: true }, z: { type: 'number', optional: true } } },
    nightfall:          { fields: {} },
    daybreak:           { fields: {} },
    eat_food:           { fields: { amount: { type: 'number', optional: true } } },
    craft_item:         { fields: { recipe: { type: 'string', optional: true } } },

    // ── RPG / Turn-based / Strategy ──
    turn_started:       { fields: { turn: { type: 'number', optional: true } } },
    turn_ended:         { fields: {} },
    turn_start:         { fields: {} },
    turn_end:           { fields: {} },
    ai_turn_start:      { fields: {} },
    victory:            { fields: {} },
    defeat:             { fields: {} },
    xp_gained:          { fields: { amount: { type: 'number' } } },
    level_up:           { fields: { level: { type: 'number' } } },
    quest_started:      { fields: { quest: { type: 'string', optional: true } } },
    quest_completed:    { fields: { quest: { type: 'string', optional: true } } },
    loot_dropped:       { fields: { item: { type: 'string', optional: true } } },
    final_boss_defeated: { fields: {} },
    select_unit:        { fields: { entityId: { type: 'number', optional: true } } },
    move_unit:          { fields: { x: { type: 'number', optional: true }, z: { type: 'number', optional: true } } },
    ai_move_unit:       { fields: { entityId: { type: 'number', optional: true }, x: { type: 'number', optional: true }, z: { type: 'number', optional: true } } },
    attack_unit:        { fields: { attackerId: { type: 'number', optional: true }, defenderId: { type: 'number', optional: true } } },
    research_tech:      { fields: { tech: { type: 'string', optional: true } } },
    adopt_policy:       { fields: { policy: { type: 'string', optional: true } } },

    // ── Climbing / Platformer Extended ──
    climb_start:        { fields: {} },
    summit_reached:     { fields: {} },

    // ── Sports / Ball ──
    goal_scored:        { fields: { team: { type: 'string', optional: true }, score: { type: 'number', optional: true } } },
    ball_kicked:        { fields: {} },
    ball_caught:        { fields: {} },
    foul_committed:     { fields: {} },
    period_ended:       { fields: { period: { type: 'number', optional: true } } },

    // ── Puzzle ──
    puzzle_solved:      { fields: {} },
    piece_placed:       { fields: { piece: { type: 'string', optional: true } } },
    piece_removed:      { fields: { piece: { type: 'string', optional: true } } },
    match_found:        { fields: { count: { type: 'number', optional: true } } },
    grid_cleared:       { fields: {} },

    // ── Party / Minigame ──
    minigame_start:     { fields: { minigame: { type: 'string', optional: true } } },
    minigame_end:       { fields: {} },
    round_complete:     { fields: { round: { type: 'number', optional: true } } },
    player_eliminated:  { fields: { playerId: { type: 'number', optional: true } } },
    crown_collected:    { fields: { playerId: { type: 'number', optional: true } } },

    // ── Elimination / Survival ──
    contestant_eliminated: { fields: { name: { type: 'string', optional: true } } },
    light_changed:      { fields: { state: { type: 'string', optional: true } } },
    panel_broken:       { fields: { panel: { type: 'number', optional: true } } },
    tile_collapsed:     { fields: { x: { type: 'number', optional: true }, z: { type: 'number', optional: true } } },

    // ── Generic / Reusable ──
    objective_complete: { fields: { objective: { type: 'string', optional: true } } },
    objective_failed:   { fields: { objective: { type: 'string', optional: true } } },
    phase_changed:      { fields: { phase: { type: 'string', optional: true } } },
    countdown_tick:     { fields: { remaining: { type: 'number' } } },
    countdown_done:     { fields: {} },
    interact:           { fields: { entityId: { type: 'number', optional: true }, action: { type: 'string', optional: true } } },
    teleport:           { fields: { entityId: { type: 'number', optional: true }, x: { type: 'number', optional: true }, y: { type: 'number', optional: true }, z: { type: 'number', optional: true } } },
    power_up:           { fields: { type: { type: 'string', optional: true }, duration: { type: 'number', optional: true } } },
    power_down:         { fields: {} },
    combo_hit:          { fields: { combo: { type: 'number', optional: true } } },
    streak_ended:       { fields: {} },
};

export const VALID_GAME_EVENTS = new Set(Object.keys(GAME_EVENTS));
