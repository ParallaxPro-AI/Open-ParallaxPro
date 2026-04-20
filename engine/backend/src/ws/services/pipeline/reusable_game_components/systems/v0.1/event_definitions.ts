/**
 * Game event definitions — single source of truth for the `game` event bus.
 * Each event has a name and a payload schema.
 * All event names must be snake_case.
 *
 * Payload field types: 'number', 'string', 'boolean', 'any'
 * Fields marked optional: true are not required.
 */
var GAME_EVENTS = {
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
    enter_vehicle:      { fields: { vehicleId: { type: 'number', optional: true } } },
    exit_vehicle:       { fields: {} },

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

    // ── Capture the Flag / Team Objective ──
    // Emitted locally by flag_bearer / banner_siege_game when a banner
    // transitions between states. `flagTeam` is which team the banner
    // belongs to (red/blue); `team` is the team of the player acting on it.
    flag_picked_up:     { fields: { peerId: { type: 'string', optional: true }, team: { type: 'string', optional: true }, flagTeam: { type: 'string', optional: true } } },
    flag_dropped:       { fields: { peerId: { type: 'string', optional: true }, flagTeam: { type: 'string', optional: true }, x: { type: 'number', optional: true }, z: { type: 'number', optional: true } } },
    flag_returned:      { fields: { flagTeam: { type: 'string', optional: true }, reason: { type: 'string', optional: true } } },
    flag_captured:      { fields: { peerId: { type: 'string', optional: true }, team: { type: 'string', optional: true }, flagTeam: { type: 'string', optional: true } } },
    team_score_changed: { fields: { red: { type: 'number', optional: true }, blue: { type: 'number', optional: true } } },

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

    // ── Multiplayer ──
    // Phase markers emitted by mp_bridge when the session's phase changes.
    // Transitions watch these via `mp_event:phase_<name>`.
    mp_phase_disconnected: { fields: {} },
    mp_phase_connecting:   { fields: {} },
    mp_phase_browsing:     { fields: {} },
    mp_phase_in_lobby:     { fields: {} },
    mp_phase_in_game:      { fields: {} },
    mp_phase_game_over:    { fields: {} },
    // Chat focus/blur: tell the flow to pause input capture while typing.
    mp_chat_focus:         { fields: {} },
    mp_chat_blur:          { fields: {} },
    // "Back to menu" from the lobby browser (not a phase — a user action).
    mp_back_to_menu:       { fields: {} },
    // Host changed mid-session. Game systems that own host-authoritative
    // state (timers, host-spawned entities) should re-claim ownership when
    // the new host id matches their local peer.
    mp_host_changed:       { fields: { newHostPeerId: { type: 'string', optional: true } } },
    // Player count fell below the game's declared minPlayers. A game can
    // listen for this and abandon the match cleanly.
    mp_below_min_players:  { fields: { count: { type: 'number', optional: true }, min: { type: 'number', optional: true } } },
    mp_roster_changed:     { fields: { count: { type: 'number', optional: true } } },
    // Match lifecycle for multiplayer templates.
    match_started:         { fields: {} },
    match_ended:           { fields: { reason: { type: 'string', optional: true }, winner: { type: 'any', optional: true } } },
    // Networked events relayed by mp_bridge — events prefixed "net_" are
    // received from a remote peer. We allowlist the ones the reference
    // templates use; project-specific net events can be added per-project.
    net_match_ended:       { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_coin_collected:    { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    // Deathmatch net events: player_shot carries the damage event across
    // peers (each peer is authoritative over its own health), and
    // player_killed is broadcast by the victim so every peer's scoreboard
    // can tally kills consistently.
    net_player_shot:       { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_player_killed:     { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_player_respawn:    { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    // Banner Siege / CTF: flag state transitions need to sync so both
    // peers see the banner follow its new owner or return to base.
    net_flag_picked_up:    { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_flag_dropped:      { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_flag_returned:     { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_flag_captured:     { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    // Team assignment broadcast from host at match start so everyone
    // agrees on who's on which team (host is authoritative).
    net_team_assignment:   { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },

    // ── Zone Royale (multiplayer_zone_royale) ──
    // Input intents emitted by player_shooter_movement + mp_hitscan_weapon +
    // loot_crate. The match system owns validation/authority — these are
    // just a narrow input vocabulary a different top-down shooter can reuse.
    royale_fire_start:          { fields: { aimX: { type: 'number', optional: true }, aimZ: { type: 'number', optional: true } } },
    royale_fire_stop:           { fields: {} },
    royale_reload_pressed:      { fields: {} },
    royale_switch_slot:         { fields: { slot: { type: 'number', optional: true } } },
    royale_heal_pressed:        { fields: {} },
    royale_pickup_pressed:      { fields: { x: { type: 'number', optional: true }, y: { type: 'number', optional: true }, z: { type: 'number', optional: true } } },
    royale_pickup_request:      { fields: { lootId: { type: 'string', optional: true }, lootKind: { type: 'string', optional: true }, kind: { type: 'string', optional: true }, payload: { type: 'any', optional: true }, x: { type: 'number', optional: true }, y: { type: 'number', optional: true }, z: { type: 'number', optional: true } } },
    royale_loot_picked_local:   { fields: { lootId: { type: 'string', optional: true } } },
    royale_loadout_set:         { fields: { slots: { type: 'any', optional: true }, index: { type: 'number', optional: true }, reserve: { type: 'any', optional: true } } },
    royale_damage_local:        { fields: { victimPeerId: { type: 'string', optional: true }, damage: { type: 'number', optional: true }, weapon: { type: 'string', optional: true }, x: { type: 'number', optional: true }, z: { type: 'number', optional: true } } },
    royale_match_reset:         { fields: {} },
    // Host-authoritative broadcasts echoed back via mp_bridge as net_* —
    // initial loot layout, storm tick snapshots, loot pickups, shots,
    // damage pings, death notices, heal/armor syncs, match-end summary.
    net_royale_loot_layout:     { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_royale_storm_tick:      { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_royale_loot_picked:     { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_royale_shot:            { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_royale_damage:          { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_royale_player_died:     { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_royale_heal:            { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_royale_armor:           { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_royale_match_ended:     { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },

    // ── Neon Cycles (light-bike combat) ──
    // Bike collided with a light wall — emitted locally first by the host's
    // collision check, then broadcast over net_bike_crashed so every peer's
    // bike state stays consistent. Trail rendering / scoring keys off these.
    bike_crashed:          { fields: { peerId: { type: 'string', optional: true }, killedBy: { type: 'string', optional: true } } },
    net_bike_crashed:      { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    // Round lifecycle — distinct from match_started/ended because a single
    // match contains multiple rounds (best-of-N). Host owns transitions.
    round_started:         { fields: { round: { type: 'number', optional: true } } },
    round_ended:           { fields: { round: { type: 'number', optional: true }, winner: { type: 'string', optional: true } } },
    net_round_started:     { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_round_ended:       { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    // Bike turned — local event used by trail emitter to start a new wall
    // segment so trails render as continuous polylines instead of jittering
    // around bike rotation. Also used by audio HUD to pulse a turn ping.
    bike_turned:           { fields: { peerId: { type: 'string', optional: true } } },

    // ── Alien Invasion (single-player retro fixed-screen shooter) ──
    // invader_ship fires "fire_pressed"; the wave system spawns the bullet,
    // tracks hits, and emits the _killed / _died / _game_* fanouts the
    // HUD + FX layer key off. All single-player so no net_* mirror.
    invader_fire_pressed:  { fields: { x: { type: 'number', optional: true }, z: { type: 'number', optional: true } } },
    invader_fire_emitted:  { fields: {} },
    invader_wave_reset:    { fields: { wave: { type: 'number', optional: true }, lives: { type: 'number', optional: true } } },
    invader_alien_killed:  { fields: { row: { type: 'number', optional: true }, col: { type: 'number', optional: true }, score: { type: 'number', optional: true } } },
    invader_ufo_killed:    { fields: { score: { type: 'number', optional: true } } },
    invader_wave_cleared:  { fields: { wave: { type: 'number', optional: true } } },
    invader_player_died:   { fields: { reason: { type: 'string', optional: true }, livesLeft: { type: 'number', optional: true }, score: { type: 'number', optional: true } } },
    invader_game_over:     { fields: { score: { type: 'number', optional: true }, highScore: { type: 'number', optional: true }, wave: { type: 'number', optional: true } } },
    invader_game_won:      { fields: { score: { type: 'number', optional: true }, highScore: { type: 'number', optional: true } } },

    // ── Kitchen Master (single-player cooking mini-game) ──
    // Stage transitions + per-stage progress pulses fanned out by the
    // engine. The HUD reads these directly so it can swap instructional
    // panels and update the chop / mix / fry visualisation in lockstep.
    recipe_stage_started:   { fields: { stage: { type: 'string', optional: true }, target: { type: 'number', optional: true }, durationSec: { type: 'number', optional: true } } },
    recipe_stage_completed: { fields: { stage: { type: 'string', optional: true }, score: { type: 'number', optional: true }, perfect: { type: 'boolean', optional: true } } },
    recipe_completed:       { fields: { totalScore: { type: 'number', optional: true }, stars: { type: 'number', optional: true } } },
    chop_made:              { fields: { count: { type: 'number', optional: true }, target: { type: 'number', optional: true } } },
    mix_progress:           { fields: { rotations: { type: 'number', optional: true }, target: { type: 'number', optional: true } } },
    fry_flipped:            { fields: { successful: { type: 'boolean', optional: true }, count: { type: 'number', optional: true }, target: { type: 'number', optional: true } } },
    fry_burnt:              { fields: {} },
    plate_added:            { fields: { count: { type: 'number', optional: true }, target: { type: 'number', optional: true } } },

    // ── Kart Race (multiplayer mario-kart style circuit racer) ──
    // Authoritative state sync sent on every progress / power-up change.
    // Item box pickups, power-up uses (boost/missile/banana/shield/bolt),
    // hazard hits + lap completions ride alongside as separate net events
    // so visuals/audio fire in lockstep across peers. Client → host
    // requests carry "I want to use my held power-up" intents.
    net_kr_state_sync:        { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_kr_item_pickup:       { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_kr_powerup_used:      { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_kr_hazard_hit:        { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_kr_lap_complete:      { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_kr_request_use:       { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },

    // ── Court Match (multiplayer NBA-style basketball) ──
    // Authoritative state sync sent on every score / possession / phase
    // change. Animation cues for shot arc + pass arc + made/missed/quarter
    // banners ride alongside so visuals + audio fire in lockstep across
    // peers. Client → host requests carry pass / shoot / steal intents.
    net_cm_state_sync:        { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_cm_shot_anim:         { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_cm_pass_anim:         { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_cm_made:              { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_cm_missed:            { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_cm_quarter_change:    { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_cm_request_pass:      { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_cm_request_shoot:     { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_cm_request_steal:     { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },

    // ── Cellar Purge (single-player Isaac-style twin-stick roguelite) ──
    // Local fanouts from cellar_purge_game so HUD + audio + room FX react
    // in the same frame mechanics fire. All single-player so no net_*.
    cp_room_entered:       { fields: { roomId: { type: 'string', optional: true }, kind: { type: 'string', optional: true } } },
    cp_room_cleared:       { fields: { roomId: { type: 'string', optional: true } } },
    cp_door_opened:        { fields: { doorId: { type: 'string', optional: true } } },
    cp_enemy_spawned:      { fields: { enemyId: { type: 'number', optional: true }, kind: { type: 'string', optional: true } } },
    cp_enemy_killed:       { fields: { enemyId: { type: 'number', optional: true }, kind: { type: 'string', optional: true } } },
    cp_tear_fired:         { fields: { dirX: { type: 'number', optional: true }, dirZ: { type: 'number', optional: true } } },
    cp_tear_hit:           { fields: { entityId: { type: 'number', optional: true } } },
    cp_pickup_collected:   { fields: { kind: { type: 'string', optional: true }, amount: { type: 'number', optional: true } } },
    cp_player_hurt:        { fields: { amount: { type: 'number', optional: true }, source: { type: 'string', optional: true } } },
    cp_player_healed:      { fields: { amount: { type: 'number', optional: true } } },
    cp_floor_complete:     { fields: { floor: { type: 'number', optional: true } } },
    cp_boss_engaged:       { fields: { name: { type: 'string', optional: true } } },
    cp_boss_defeated:      { fields: { name: { type: 'string', optional: true } } },

    // ── Liminal Loop (single-player anomaly-detection corridor walker) ──
    // Local fanouts from liminal_loop_game so the HUD + audio + atmospheric
    // FX can react to each iteration without poking at the system internals.
    // All single-player so no net_* equivalents.
    ll_iteration_started:  { fields: { iteration: { type: 'number', optional: true }, anomalyKind: { type: 'string', optional: true }, hasAnomaly: { type: 'boolean', optional: true } } },
    ll_anomaly_appeared:   { fields: { kind: { type: 'string', optional: true } } },
    ll_choice_committed:   { fields: { choice: { type: 'string', optional: true }, correct: { type: 'boolean', optional: true } } },
    ll_choice_correct:     { fields: { newExitNumber: { type: 'number', optional: true } } },
    ll_choice_wrong:       { fields: { reason: { type: 'string', optional: true } } },
    ll_exit_reached:       { fields: { exitNumber: { type: 'number', optional: true } } },
    ll_progress_changed:   { fields: { exitNumber: { type: 'number', optional: true }, target: { type: 'number', optional: true } } },

    // ── Pirate Voyage (multiplayer treasure hunt) ──
    // Treasure pickup synced from the claiming peer so every captain's
    // scoreboard updates and the visual barrel disappears in the same
    // frame. Host then spawns a fresh treasure elsewhere via
    // net_treasure_spawned so the seas don't run dry mid-match.
    net_treasure_collected: { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_treasure_spawned:   { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    // Ship sinking + respawn broadcasts so kill feeds + remote proxy
    // animations can react. Carries victim/killer peer IDs in `data`.
    net_ship_sunk:          { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_ship_respawn:       { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },

    // ── Pickaxe Keep (2.5D sidescroll mining + crafting sandbox) ──
    // Local fanouts from block_interactor + pickaxe_keep_game so HUD + SFX
    // + FX react the same frame the block grid changes. (x, y) are integer
    // cells in the world's block map; blockType is "dirt"/"stone"/etc.
    pk_block_mined:        { fields: { x: { type: 'number', optional: true }, y: { type: 'number', optional: true }, blockType: { type: 'string', optional: true }, peerId: { type: 'string', optional: true } } },
    pk_block_placed:       { fields: { x: { type: 'number', optional: true }, y: { type: 'number', optional: true }, blockType: { type: 'string', optional: true }, peerId: { type: 'string', optional: true } } },
    pk_item_collected:     { fields: { item: { type: 'string', optional: true }, count: { type: 'number', optional: true } } },
    pk_craft_attempted:    { fields: { recipe: { type: 'string', optional: true } } },
    pk_craft_succeeded:    { fields: { recipe: { type: 'string', optional: true } } },
    pk_hotbar_selected:    { fields: { slot: { type: 'number', optional: true } } },
    pk_inventory_changed:  { fields: {} },
    pk_time_changed:       { fields: { time: { type: 'number', optional: true }, phase: { type: 'string', optional: true } } },
    pk_enemy_spawned:      { fields: { enemyId: { type: 'number', optional: true }, enemyType: { type: 'string', optional: true } } },
    pk_enemy_killed:       { fields: { enemyId: { type: 'number', optional: true } } },
    pk_player_hurt:        { fields: { amount: { type: 'number', optional: true }, source: { type: 'string', optional: true } } },
    // Intent events — block_interactor emits these on click/keypress,
    // pickaxe_keep_game owns range + tier + cooldown checks. Splitting
    // intents from application lets the same behavior drop into a
    // creative-mode / PvP-mode / challenge-mode variant.
    pk_intent_mine:        { fields: { x: { type: 'number', optional: true }, y: { type: 'number', optional: true }, entityId: { type: 'number', optional: true } } },
    pk_intent_place:       { fields: { x: { type: 'number', optional: true }, y: { type: 'number', optional: true } } },
    pk_intent_attack:      { fields: { entityId: { type: 'number', optional: true }, x: { type: 'number', optional: true }, y: { type: 'number', optional: true } } },
    pk_toggle_inventory:   { fields: {} },
    // Host-authoritative broadcasts relayed via mp_bridge as net_*. World
    // init carries the full opening block list; deltas broadcast single
    // mutations; time sync keeps day/night aligned without dead reckoning.
    net_pk_world_init:     { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_pk_block_mined:    { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_pk_block_placed:   { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_pk_enemy_spawned:  { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_pk_enemy_killed:   { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_pk_enemy_update:   { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_pk_time_sync:      { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_pk_player_damaged: { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },

    // ── Jelly Jam (multiplayer party-elimination minigame bracket) ──
    // Local fanouts from jelly_player + jelly_jam_game so HUD + SFX react
    // without each piece poking at the others' internals. `jj_round_*` is
    // the round-bracket lifecycle; `jj_player_*` is the qualify/eliminate
    // axis; `jj_obstacle_hit` is a per-collision pulse used by camera
    // shake + audio. Diving (Q) and grabbing (E) are echoed across peers
    // so other proxies play the right animation in the same frame.
    jj_round_starting:     { fields: { round: { type: 'number', optional: true }, totalRounds: { type: 'number', optional: true }, name: { type: 'string', optional: true } } },
    jj_round_started:      { fields: { round: { type: 'number', optional: true } } },
    jj_round_ended:        { fields: { round: { type: 'number', optional: true } } },
    jj_player_qualified:   { fields: { peerId: { type: 'string', optional: true }, place: { type: 'number', optional: true } } },
    jj_player_eliminated:  { fields: { peerId: { type: 'string', optional: true } } },
    jj_obstacle_hit:       { fields: { peerId: { type: 'string', optional: true }, force: { type: 'number', optional: true } } },
    jj_dive_started:       { fields: { peerId: { type: 'string', optional: true } } },
    jj_dive_landed:        { fields: { peerId: { type: 'string', optional: true } } },
    // Host-authoritative broadcasts relayed via mp_bridge as net_*. Course
    // init carries the seeded obstacle layout for each round so all peers
    // build the same arena. Qualify + eliminate fan in from the host's
    // finish-line trigger.
    net_jj_course_init:    { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_jj_qualify:        { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_jj_eliminate:      { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_jj_round_start:    { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_jj_round_end:      { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_jj_dive:           { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_jj_grab:           { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },

    // ── Lawn Defenders (single-player lane defense) ──
    // Player + economy pulses fanned out by the engine. The HUD reads
    // these straight off the bus instead of polling for sun / wave /
    // armed-plant state every frame. Single-player so no net_* echoes.
    sun_changed:          { fields: { sun: { type: 'number', optional: true }, delta: { type: 'number', optional: true } } },
    sun_blob_spawned:     { fields: { x: { type: 'number', optional: true }, z: { type: 'number', optional: true }, fromSky: { type: 'boolean', optional: true } } },
    sun_blob_collected:   { fields: { amount: { type: 'number', optional: true }, x: { type: 'number', optional: true }, z: { type: 'number', optional: true } } },
    plant_armed:          { fields: { plant: { type: 'string', optional: true }, cost: { type: 'number', optional: true } } },
    plant_armed_cleared:  { fields: {} },
    plant_placed:         { fields: { plant: { type: 'string', optional: true }, col: { type: 'number', optional: true }, row: { type: 'number', optional: true } } },
    plant_destroyed:      { fields: { col: { type: 'number', optional: true }, row: { type: 'number', optional: true } } },
    zombie_spawned:       { fields: { kind: { type: 'string', optional: true }, row: { type: 'number', optional: true } } },
    zombie_killed:        { fields: { kind: { type: 'string', optional: true }, row: { type: 'number', optional: true } } },
    zombie_reached_house: { fields: { row: { type: 'number', optional: true } } },
    wave_progress:        { fields: { wave: { type: 'number', optional: true }, totalWaves: { type: 'number', optional: true }, alive: { type: 'number', optional: true }, remaining: { type: 'number', optional: true } } },
    cherry_detonated:     { fields: { col: { type: 'number', optional: true }, row: { type: 'number', optional: true } } },

    // ── Rocket Pitch (multiplayer_rocket_pitch — car football) ──
    // Local fan-outs from the car + ball behaviours + match system so
    // HUD/SFX can react without chaining through the wire.
    rocket_jump_pressed:    { fields: {} },
    rocket_boost_tick:      { fields: { amount: { type: 'number', optional: true }, peerId: { type: 'string', optional: true } } },
    rocket_ball_reset:      { fields: { x: { type: 'number', optional: true }, y: { type: 'number', optional: true }, z: { type: 'number', optional: true } } },
    rocket_ball_hit_local:  { fields: { byPeerId: { type: 'string', optional: true }, x: { type: 'number', optional: true }, y: { type: 'number', optional: true }, z: { type: 'number', optional: true }, impulse: { type: 'number', optional: true } } },
    rocket_match_reset:     { fields: {} },
    // Host-authoritative broadcasts echoed via mp_bridge as net_* —
    // kickoff flow, ball pose + hit fanout, goals, periodic score +
    // boost sync, boost pad pickup, team assignment, match end.
    net_rocket_kickoff:      { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_rocket_go:           { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_rocket_ball_state:   { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_rocket_ball_hit:     { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_rocket_goal:         { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_rocket_score_update: { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_rocket_boost_pickup: { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_rocket_team_assign:  { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_rocket_match_ended:  { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },

    // ── Lane Hopper (single-player endless lane-crossing) ──
    // Single-player so no net_* mirror. tile_hopper + lane_hopper_game
    // share these: hop start/land drives the procedural lane extension
    // + stale-timer reset, reset snaps the chicken back to (0,0) on a
    // new run, death carries run stats to the HUD + game-over panel,
    // coin pings the counter bump.
    hop_start:   { fields: { dx: { type: 'number', optional: true }, dz: { type: 'number', optional: true }, tx: { type: 'number', optional: true }, tz: { type: 'number', optional: true } } },
    hop_landed:  { fields: { tx: { type: 'number', optional: true }, tz: { type: 'number', optional: true } } },
    hop_reset:   { fields: { tx: { type: 'number', optional: true }, tz: { type: 'number', optional: true } } },
    hop_death:   { fields: { reason: { type: 'string', optional: true }, score: { type: 'number', optional: true }, coins: { type: 'number', optional: true }, attempts: { type: 'number', optional: true } } },
    hop_coin:    { fields: { total: { type: 'number', optional: true } } },

    // ── Pipe Runner (single-player 2.5D side-scrolling platformer) ──
    // Per-run pulses fanned out by pipe_runner_engine. The HUD reads
    // these straight off the bus instead of polling the engine for
    // lives / coins / time / score state every frame.
    runner_jumped:        { fields: {} },
    runner_stomped:       { fields: { enemyId: { type: 'number', optional: true }, combo: { type: 'number', optional: true } } },
    runner_powered_up:    { fields: { kind: { type: 'string', optional: true } } },
    runner_powered_down:  { fields: {} },
    runner_coin_grabbed:  { fields: { total: { type: 'number', optional: true } } },
    runner_life_lost:     { fields: { lives: { type: 'number', optional: true }, reason: { type: 'string', optional: true } } },
    runner_extra_life:    { fields: { lives: { type: 'number', optional: true } } },
    runner_block_hit:     { fields: { blockId: { type: 'number', optional: true }, kind: { type: 'string', optional: true } } },
    runner_flag_reached:  { fields: { time: { type: 'number', optional: true }, score: { type: 'number', optional: true } } },
    runner_time_warning:  { fields: { time: { type: 'number', optional: true } } },

    // ── Noodle Jaunt (Human Fall Flat-style floppy puzzle platformer) ──
    // Local fanouts from noodle_jaunt_game / grab_arms so the HUD + audio
    // react to grab/climb/puzzle moments. `nj_grab_*` is per-hand intent
    // from grab_arms; the system applies the climb/carry consequence.
    nj_grab_started:       { fields: { peerId: { type: 'string', optional: true }, hand: { type: 'string', optional: true }, kind: { type: 'string', optional: true } } },
    nj_grab_released:      { fields: { peerId: { type: 'string', optional: true }, hand: { type: 'string', optional: true } } },
    nj_button_pressed:     { fields: { buttonId: { type: 'string', optional: true } } },
    nj_button_released:    { fields: { buttonId: { type: 'string', optional: true } } },
    nj_door_opened:        { fields: { doorId: { type: 'string', optional: true } } },
    nj_door_closed:        { fields: { doorId: { type: 'string', optional: true } } },
    nj_plate_pressed:      { fields: { plateId: { type: 'string', optional: true } } },
    nj_plate_released:     { fields: { plateId: { type: 'string', optional: true } } },
    nj_stage_completed:    { fields: { stage: { type: 'number', optional: true } } },
    nj_player_finished:    { fields: { peerId: { type: 'string', optional: true }, place: { type: 'number', optional: true }, time: { type: 'number', optional: true } } },
    nj_player_respawned:   { fields: { peerId: { type: 'string', optional: true }, x: { type: 'number', optional: true }, z: { type: 'number', optional: true } } },
    // Host-authoritative broadcasts relayed via mp_bridge as net_*. Door /
    // plate / button state is host-authoritative so all peers' world stays
    // in sync. Finish is host-decided so the leaderboard agrees.
    net_nj_button_state:   { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_nj_door_state:     { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_nj_plate_state:    { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_nj_player_finished:{ fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_nj_match_ended:    { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },

    // ── Rift 1v1 (multiplayer mid-lane MOBA) ──
    // Local input intents the master system consumes + a shop toggle
    // for the B-key overlay. All validation/authority happens on the
    // host; the behaviour just forwards the player's intent.
    rift_move_order:      { fields: { x: { type: 'number', optional: true }, z: { type: 'number', optional: true } } },
    rift_ability_pressed: { fields: { slot: { type: 'string', optional: true }, aimX: { type: 'number', optional: true }, aimZ: { type: 'number', optional: true } } },
    rift_basic_attack:    { fields: { aimX: { type: 'number', optional: true }, aimZ: { type: 'number', optional: true } } },
    rift_shop_toggle:     { fields: {} },
    // Host-authoritative broadcasts echoed via mp_bridge as net_* —
    // periodic state sync (hp / gold / kda / minions / towers / nexus),
    // damage pings, kill + respawn, minion spawn/despawn, projectile
    // visuals + hits, ability cast fan-out, team assignment, match end.
    net_rift_state_sync:      { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_rift_damage:          { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_rift_kill:            { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_rift_minion_spawn:    { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_rift_minion_despawn:  { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_rift_projectile:      { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_rift_ability_cast:    { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_rift_teams:           { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_rift_match_ended:     { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },

    // ── Pin Pal (Wii Sports-style multiplayer turn-based bowling) ──
    // Local fanouts from pin_pal_game so HUD + audio react to throws,
    // pins falling, and frame results in the same frame they happen.
    pp_aim_changed:        { fields: { peerId: { type: 'string', optional: true }, aim: { type: 'number', optional: true }, power: { type: 'number', optional: true } } },
    pp_throw_taken:        { fields: { peerId: { type: 'string', optional: true }, power: { type: 'number', optional: true }, aim: { type: 'number', optional: true } } },
    pp_pin_count:          { fields: { peerId: { type: 'string', optional: true }, count: { type: 'number', optional: true }, throwIdx: { type: 'number', optional: true } } },
    pp_frame_complete:     { fields: { peerId: { type: 'string', optional: true }, frame: { type: 'number', optional: true }, frameScore: { type: 'number', optional: true }, total: { type: 'number', optional: true } } },
    pp_strike:             { fields: { peerId: { type: 'string', optional: true }, frame: { type: 'number', optional: true } } },
    pp_spare:              { fields: { peerId: { type: 'string', optional: true }, frame: { type: 'number', optional: true } } },
    pp_gutter:             { fields: { peerId: { type: 'string', optional: true } } },
    pp_turn_changed:       { fields: { peerId: { type: 'string', optional: true }, frame: { type: 'number', optional: true }, throwIdx: { type: 'number', optional: true } } },
    pp_match_won:          { fields: { peerId: { type: 'string', optional: true }, score: { type: 'number', optional: true } } },
    // Host-authoritative net broadcasts. Throw is broadcast so non-host
    // peers play the SFX + see the cleared aim. Pin counts + turn rotation
    // come from the host so all peers' scoresheets agree.
    net_pp_aim:            { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_pp_throw:          { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_pp_pin_count:      { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_pp_frame_score:    { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_pp_turn:           { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_pp_pins_reset:     { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
    net_pp_match_ended:    { fields: { from: { type: 'string', optional: true }, data: { type: 'any', optional: true } } },
};

var VALID_GAME_EVENTS = new Set(Object.keys(GAME_EVENTS));
