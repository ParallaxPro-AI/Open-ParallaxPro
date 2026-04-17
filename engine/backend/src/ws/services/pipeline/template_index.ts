/**
 * Picks the closest matching reference template for a CREATE_GAME description.
 *
 * Two paths:
 *   1. Embedding similarity (preferred). At backend startup we embed each
 *      template's hand-curated description with the same all-MiniLM-L6-v2
 *      model used for asset search. Per-request: embed the user's
 *      description and pick the highest-cosine-similarity template above
 *      a threshold.
 *   2. Keyword fallback. If embeddings haven't finished initializing yet
 *      or the embedder fails, we fall back to a hand-curated keyword table.
 *
 * Embeddings are cached to disk; subsequent boots are ~instant.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
    initEmbedder,
    embedText,
    embedTexts,
    cosineSimilarity,
    computeFingerprint,
} from '../../../embedding_service.js';

const __dirname_ti = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_EMBEDDINGS_CACHE = path.resolve(__dirname_ti, '../../../../.template_embeddings_cache.json');

// Min cosine similarity to count as a match. Vectors are normalized; ~0.35
// separates "real fit" from "no idea" for our hand-curated descriptions.
const SIMILARITY_THRESHOLD = 0.35;

// Each template has a hand-written description rich enough for the embedder
// to pick up genre, mechanics, and common nicknames. Keep these in sync
// with the actual game_templates/v0.1/<id>/ directories.
export const TEMPLATES: Array<{ id: string; description: string }> = [
    { id: 'stumble_dash',          description: 'parkour obstacle course geometry dash style auto-running platformer with jumps spikes and checkpoints' },
    { id: 'street_surfer',         description: 'endless runner subway surfers temple run lane switching with chase and procedural obstacles' },
    { id: 'racing',                description: 'circuit lap race with cars formula 1 mario kart drift arcade racing AI opponents speedometer' },
    { id: 'platformer',            description: 'side scrolling platformer mario style jump and coins enemies lives goal' },
    { id: 'fps_shooter',           description: 'multiplayer first person shooter deathmatch FPS combat lobby kills crosshair' },
    { id: 'survival_zone',         description: 'battle royale shrinking zone last man standing FPS survival pubg fortnite' },
    { id: 'sandbox_survival',      description: 'minecraft style voxel survival block mining crafting hostile mobs day night' },
    { id: 'voxel_survival',        description: 'voxel sandbox survival NPC village farming animals quests' },
    { id: 'mmorpg',                description: 'open world RPG quests mobs bosses loot dungeon adventure MMO health mana XP level' },
    { id: 'open_world_crime',      description: 'GTA style open world crime wanted level vehicles cars driving police' },
    { id: 'moba',                  description: 'MOBA lane pusher league of legends dota hero abilities minions tower nexus' },
    { id: 'rts_battle',            description: 'real time strategy RTS unit combat starcraft warcraft buildings resources commander' },
    { id: '4x_strategy',           description: 'turn-based 4X civilization strategy tech tree diplomacy era empire' },
    { id: 'tower_siege',           description: 'tower defense waves enemies tower placement gold lives upgrade' },
    { id: 'armor_assault',         description: 'wave-based tank combat armor battle cannon reload enemies' },
    { id: 'pong',                  description: 'classic pong two paddle ball arcade game vs AI' },
    { id: 'chess',                 description: 'chess board game vs AI piece movement strategy classic' },
    { id: 'soccer',                description: 'soccer football match player vs AI ball physics goals score timer' },
    { id: 'party_bash',            description: 'party game minigames mario party local multiplayer minigame battler rounds' },
    { id: 'deadly_games',          description: 'squid game red light green light glass bridge elimination rounds three-round' },
    { id: 'multiplayer_coin_grab', description: 'multiplayer coin collection FFA free for all simple multiplayer with lobby' },
    { id: 'buccaneer_bay',         description: 'multiplayer pirate sea adventure sea of thieves style ship sailing cannon combat treasure hunt kraken islands open ocean' },
    { id: 'pickaxe_keep',          description: 'multiplayer terraria style 2.5D sidescroll mining building survival sandbox dig blocks craft pickaxe sword fight zombies day night cycle ore stone iron diamond' },
    { id: 'jelly_jam',             description: 'multiplayer fall guys style party elimination minigame bracket sprint race obstacle course spinning beam dive jump qualify eliminated bracket podium chaotic party game' },
    { id: 'noodle_jaunt',          description: 'multiplayer co-op human fall flat gang beasts style floppy physics puzzle platformer ragdoll character LMB RMB grab climb push button pressure plate cube checkpoint goal flag wobble' },
    { id: 'pin_pal',               description: 'multiplayer wii sports nintendo switch sports style ten pin bowling turn based 10 frame strike spare gutter aim power meter physics ball pins alley arcade casual sports' },
    { id: 'lawn_defenders',        description: 'single-player plants vs zombies style lane defense tower garden sunflower peashooter cherry bomb wallnut zombie waves sun economy lawn grass home base tile grid' },
    { id: 'multiplayer_rocket_pitch', description: 'multiplayer rocket league style car football car soccer boost jump ball physics goals kickoff cars arena 2v2 3v3 supersonic acrobatic vehicular rocket pitch' },
    { id: 'lane_hopper',           description: 'single-player crossy road frogger style endless lane-crossing chicken hop traffic logs rivers coins tile lanes infinite procedural arcade hopper' },
    { id: 'pipe_runner',           description: 'single-player super mario 2.5D side-scrolling platformer jump stomp goombas koopas coins warp pipes flagpole lives time score mushroom powerup 2d platformer' },
    { id: 'multiplayer_rift_1v1',  description: 'multiplayer 1v1 league of legends mid lane MOBA style hero abilities minions tower gold shop item build nexus last hit solo queue duel' },
    { id: 'alien_invasion',        description: 'single-player space invaders galaga style retro fixed-screen shooter arcade laser cannon aliens descending rows UFO score waves classic 8-bit shmup' },
    { id: 'banner_siege',          description: 'multiplayer capture the flag CTF team objective banner siege two teams red blue bases flag planting stealing rally attack defend team combat' },
    { id: 'cellar_purge',          description: 'single-player binding of isaac style top-down twin-stick roguelite dungeon crawler tear projectiles arrow keys WASD rooms zombies boss hearts coins keys pickups basement cellar' },
    { id: 'court_clash',           description: 'multiplayer NBA 2K style basketball sports game two teams home away quarters scoreboard shot meter pass steal hoop rim three pointer two pointer baller dribble court arena' },
    { id: 'kart_karnival',         description: 'multiplayer mario kart style arcade kart racing circuit laps drift boost item boxes power ups missile banana shield bolt grand prix party racer 8 player' },
    { id: 'kitchen_master',        description: 'single-player cooking mama overcooked solo style kitchen cooking mini-game chop mix fry plate timer recipe stars perfect scoring food prep restaurant chef' },
    { id: 'liminal_loop',          description: 'single-player exit 8 style anomaly detection corridor walking simulator subway hallway fluorescent lights spot the difference psychological horror puzzle turn back continue forward' },
    { id: 'multiplayer_neon_cycles', description: 'multiplayer tron light cycles neon bikes arena light wall trail combat best of N rounds turn swerve crash elimination survival wall game' },
    { id: 'multiplayer_zone_royale', description: 'multiplayer top-down battle royale looter shooter surviv.io fortnite io style last one standing storm shrinking loot crates weapons armor heal arena' },
];

let templateEmbeddings: Map<string, number[]> | null = null;
let initPromise: Promise<void> | null = null;

export function templateIndexReady(): boolean {
    return templateEmbeddings !== null;
}

// Idempotent — safe to call multiple times. Concurrent calls share the same
// in-flight promise.
export function initTemplateEmbeddings(): Promise<void> {
    if (initPromise) return initPromise;
    initPromise = (async () => {
        const corpus = TEMPLATES.map(t => ({ key: t.id, text: t.description }));
        const fingerprint = computeFingerprint(corpus);

        if (fs.existsSync(TEMPLATE_EMBEDDINGS_CACHE)) {
            try {
                const data = JSON.parse(fs.readFileSync(TEMPLATE_EMBEDDINGS_CACHE, 'utf-8'));
                if (data && data.fingerprint === fingerprint && data.embeddings) {
                    templateEmbeddings = new Map(Object.entries(data.embeddings));
                    console.log(`[Templates] Loaded ${templateEmbeddings.size} cached template embeddings`);
                    return;
                }
            } catch {
                // Corrupt cache — recompute below.
            }
        }

        await initEmbedder();
        const vectors = await embedTexts(corpus.map(c => c.text));
        const map: Record<string, number[]> = {};
        corpus.forEach((c, i) => { map[c.key] = vectors[i]; });

        templateEmbeddings = new Map(Object.entries(map));
        try {
            fs.writeFileSync(TEMPLATE_EMBEDDINGS_CACHE, JSON.stringify({ fingerprint, embeddings: map }));
        } catch (e: any) {
            console.warn(`[Templates] Failed to write embeddings cache: ${e.message}`);
        }
        console.log(`[Templates] Embedded ${TEMPLATES.length} templates (cached to disk)`);
    })();
    return initPromise;
}

export interface TemplatePick {
    id: string | null;
    score: number;        // cosine similarity (0..1) when from embeddings; 1 when keyword hit; 0 when null
    method: 'embedding' | 'keyword' | 'none';
}

export async function pickClosestTemplate(description: string): Promise<TemplatePick> {
    // Wait for embeddings if init is in flight; fall through to keywords on failure.
    if (initPromise) {
        try { await initPromise; } catch { /* fall through */ }
    }

    if (templateEmbeddings) {
        try {
            const queryVec = await embedText(description);
            let bestId: string | null = null;
            let bestScore = -Infinity;
            for (const [id, vec] of templateEmbeddings) {
                const score = cosineSimilarity(queryVec, vec);
                if (score > bestScore) { bestScore = score; bestId = id; }
            }
            if (bestId && bestScore >= SIMILARITY_THRESHOLD) {
                return { id: bestId, score: bestScore, method: 'embedding' };
            }
            // Embedding came up empty — try keyword as second chance.
        } catch {
            // Embedder errored mid-request — fall through to keywords.
        }
    }

    const kw = pickClosestTemplateByKeyword(description);
    if (kw) return { id: kw, score: 1, method: 'keyword' };
    return { id: null, score: 0, method: 'none' };
}

// ─── Keyword fallback ──────────────────────────────────────────────────────
//
// Used while embeddings are still warming up at boot, or as a second-chance
// after embedding misses. Order matters: more specific keywords come first
// so e.g. "multiplayer fps shooter" matches fps_shooter before plain "fps".

const TEMPLATE_KEYWORDS: Array<[string[], string]> = [
    [['squid game', 'red light green light', 'glass bridge', 'elimination round'], 'deadly_games'],
    [['among us', 'social deduction', 'impostor'], 'multiplayer_coin_grab'],
    [['battle royale', 'pubg', 'fortnite', 'shrinking zone', 'zone shrinks'], 'survival_zone'],
    [['multiplayer fps', 'multiplayer shooter', 'multiplayer deathmatch', 'mp fps'], 'fps_shooter'],
    [['multiplayer coin', 'coin grab', 'coin ffa', 'multiplayer ffa'], 'multiplayer_coin_grab'],
    [['geometry dash', 'parkour', 'obstacle course'], 'stumble_dash'],
    [['endless runner', 'subway surfer', 'temple run'], 'street_surfer'],
    [['mario kart', 'kart racing', 'arcade racing', 'circuit racing', 'racing', 'drift', 'f1', 'formula 1', 'formula one', 'lap race'], 'racing'],
    [['platformer', 'mario', 'side scroller', 'jump and coin', 'jump-and-coin'], 'platformer'],
    [['gta', 'open world crime', 'wanted level'], 'open_world_crime'],
    [['mmorpg', 'mmo', 'rpg', 'quest', 'adventure', 'loot', 'dungeon'], 'mmorpg'],
    [['moba', 'league of legends', 'dota', 'lane pusher'], 'moba'],
    [['rts', 'real time strategy', 'starcraft', 'warcraft', 'unit combat'], 'rts_battle'],
    [['civilization', 'civ ', '4x', 'turn-based strategy', 'turn based strategy'], '4x_strategy'],
    [['minecraft', 'voxel survival', 'voxel sandbox'], 'sandbox_survival'],
    [['voxel npc', 'voxel village', 'farming sim'], 'voxel_survival'],
    [['fps', 'shooter', 'deathmatch', 'first person shooter', 'first-person shooter'], 'fps_shooter'],
    [['tank battle', 'wave combat', 'tank wave'], 'armor_assault'],
    [['tower defense', 'td ', 'tower siege'], 'tower_siege'],
    [['pong'], 'pong'],
    [['chess'], 'chess'],
    [['soccer', 'football'], 'soccer'],
    [['party game', 'minigame pack', 'mario party'], 'party_bash'],
    [['sea of thieves', 'pirate ship', 'pirate sea', 'pirate adventure', 'pirate multiplayer', 'galleon', 'cannon ship', 'naval combat', 'treasure hunting'], 'buccaneer_bay'],
    [['terraria', '2d sandbox mining', 'sidescroll mining', '2d mining', 'sidescroll sandbox', 'pickaxe sandbox', 'block dig sandbox', '2d survival craft'], 'pickaxe_keep'],
    [['fall guys', 'fallguys', 'stumble guys', 'pummel party', 'party royale', 'party elimination', 'minigame bracket', 'spinning beams', 'obstacle course party', 'multiplayer party game'], 'jelly_jam'],
    [['human fall flat', 'human: fall flat', 'fall flat', 'gang beasts', 'totally reliable delivery', 'floppy physics', 'ragdoll puzzle', 'wobble platformer', 'co-op puzzle platformer', 'physics co-op'], 'noodle_jaunt'],
    [['wii sports', 'nintendo switch sports', 'wii bowling', 'switch bowling', 'ten pin bowling', '10 pin bowling', 'bowling alley', 'casual sports compilation', 'arcade bowling'], 'pin_pal'],
    [['plants vs zombies', 'pvz', 'lawn defense', 'lane tower defense', 'plant defense', 'sunflower peashooter', 'cherry bomb', 'zombie lanes', 'garden defense'], 'lawn_defenders'],
    [['rocket league', 'rocketleague', 'car football', 'car soccer', 'soccar', 'supersonic acrobatic', 'rocket pitch', 'boost cars ball', 'vehicular soccer'], 'multiplayer_rocket_pitch'],
    [['crossy road', 'crossyroad', 'frogger', 'lane crossing', 'hop across road', 'chicken crossing traffic', 'endless hop', 'log river frogger'], 'lane_hopper'],
    [['super mario', 'mario bros', 'mario platformer', 'warp pipes', 'goomba koopa', 'side scrolling mario', 'flagpole platformer', '2d mario', 'mario style platformer'], 'pipe_runner'],
    [['1v1 moba', 'mid lane 1v1', 'mid lane solo', 'league 1v1', 'dota 1v1', 'moba duel', 'rift 1v1', 'mid solo moba', 'solo lane moba'], 'multiplayer_rift_1v1'],
    [['space invaders', 'space-invaders', 'galaga', 'galaxian', 'fixed screen shooter', 'retro shmup', 'alien shooter retro', 'invaders arcade'], 'alien_invasion'],
    [['capture the flag', 'ctf', 'banner siege', 'team objective flag', 'flag planting', 'flag capture multiplayer', 'attack defend flag'], 'banner_siege'],
    [['binding of isaac', 'isaac', 'enter the gungeon', 'gungeon', 'nuclear throne', 'twin stick roguelite', 'twin-stick shooter', 'top down dungeon crawler', 'tears projectile shooter', 'roguelite dungeon'], 'cellar_purge'],
    [['nba 2k', 'nba2k', 'basketball game', 'basketball sim', 'street basketball', 'pickup basketball', 'hoops game', '2k basketball', 'nba live', 'streetball'], 'court_clash'],
    [['mario kart', 'mariokart', 'kart racer', 'kart racing', 'crash team racing', 'kart battle', 'item box racer', 'banana shield missile racer', 'arcade kart', 'grand prix kart'], 'kart_karnival'],
    [['cooking mama', 'cooking game', 'kitchen game', 'overcooked solo', 'recipe mini-game', 'chop mix fry', 'cooking time management', 'restaurant chef cooking'], 'kitchen_master'],
    [['exit 8', 'exit eight', '8 ban deguchi', 'anomaly detection', 'spot the difference walking', 'liminal corridor', 'subway loop horror', 'turn back if anomaly', 'corridor walker puzzle'], 'liminal_loop'],
    [['tron', 'light cycle', 'light cycles', 'light bike', 'neon bikes', 'lightcycle arena', 'trail combat arena', 'tron grid', 'disc arena bikes'], 'multiplayer_neon_cycles'],
    [['surviv.io', 'zone royale', 'zoneroyale', 'top-down battle royale', 'looter shooter royale', 'io battle royale', 'storm circle royale', 'top down br', 'io last man standing'], 'multiplayer_zone_royale'],
];

function pickClosestTemplateByKeyword(description: string): string | null {
    const lower = ' ' + description.toLowerCase() + ' ';
    for (const [keywords, templateId] of TEMPLATE_KEYWORDS) {
        for (const k of keywords) {
            if (lower.includes(' ' + k) || lower.includes(k + ' ') || lower.includes(' ' + k + ' ')) {
                return templateId;
            }
        }
    }
    return null;
}

// Trigger embedding init at module load. Non-blocking; pickClosestTemplate
// awaits it on demand.
initTemplateEmbeddings().catch(err => {
    console.error('[Templates] Failed to initialize embeddings:', err.message);
});
