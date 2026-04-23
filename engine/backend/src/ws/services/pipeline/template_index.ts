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
    embedQuery,
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
    { id: 'stumble_dash',          description: 'parkour obstacle course geometry dash style auto-running platformer with jumps spikes and checkpoints 跑酷障碍赛 パルクール장애물달리기' },
    { id: 'street_surfer',         description: 'endless runner subway surfers temple run lane switching with chase and procedural obstacles 无尽跑酷 地下鉄サーファー 서브웨이서퍼 วิ่งไม่หยุด' },
    { id: 'racing',                description: 'circuit lap race with cars formula 1 mario kart drift arcade racing AI opponents speedometer 赛车竞速 レース 레이싱 แข่งรถ' },
    { id: 'platformer',            description: 'side scrolling platformer mario style jump and coins enemies lives goal 平台跳跃 マリオ 플랫포머 เกมกระโดด' },
    { id: 'fps_shooter',           description: 'multiplayer first person shooter deathmatch FPS combat lobby kills crosshair 第一人称射击 FPSシューター 슈팅게임 เกมยิง valorant csgo' },
    { id: 'survival_zone',         description: 'battle royale shrinking zone last man standing FPS survival pubg fortnite 大逃杀吃鸡 バトルロイヤル 배틀로얄 เกมเอาชีวิตรอด' },
    { id: 'sandbox_survival',      description: 'minecraft style voxel survival block mining crafting hostile mobs day night 我的世界 マインクラフト 마인크래프트 มายคราฟ' },
    { id: 'voxel_survival',        description: 'voxel sandbox survival NPC village farming animals quests 体素生存 ボクセルサバイバル 복셀서바이벌' },
    { id: 'mmorpg',                description: 'open world RPG quests mobs bosses loot dungeon adventure MMO health mana XP level 角色扮演 RPG ロールプレイング 역할수행게임 เกมอาร์พีจี' },
    { id: 'open_world_crime',      description: 'GTA style open world crime wanted level vehicles cars driving police 侠盗猎车 グランドセフトオート GTA 오픈월드' },
    { id: 'moba',                  description: 'MOBA lane pusher league of legends dota hero abilities minions tower nexus 英雄联盟 王者荣耀 モバ 롤 리그오브레전드' },
    { id: 'rts_battle',            description: 'real time strategy RTS unit combat starcraft warcraft buildings resources commander 即时战略 リアルタイムストラテジー 실시간전략' },
    { id: '4x_strategy',           description: 'turn-based 4X civilization strategy tech tree diplomacy era empire 文明 回合制策略 ターン制ストラテジー 전략시뮬레이션' },
    { id: 'tower_siege',           description: 'tower defense waves enemies tower placement gold lives upgrade 塔防 タワーディフェンス 타워디펜스 เกมป้องกันป้อม' },
    { id: 'armor_assault',         description: 'wave-based tank combat armor battle cannon reload enemies 坦克战斗 戦車バトル 탱크전투' },
    { id: 'pong',                  description: 'classic pong two paddle ball arcade game vs AI 乒乓 ポン 탁구게임' },
    { id: 'chess',                 description: 'chess board game vs AI piece movement strategy classic 国际象棋 棋 チェス 체스 หมากรุก' },
    { id: 'soccer',                description: 'soccer football match player vs AI ball physics goals score timer 足球 サッカー 축구 ฟุตบอล' },
    { id: 'party_bash',            description: 'party game minigames mario party local multiplayer minigame battler rounds 派对游戏 パーティーゲーム 파티게임 เกมปาร์ตี้' },
    { id: 'deadly_games',          description: 'squid game red light green light glass bridge elimination rounds three-round 鱿鱼游戏 イカゲーム 오징어게임 สควิดเกม' },
    { id: 'multiplayer_coin_grab', description: 'multiplayer coin collection FFA free for all simple multiplayer with lobby 金币收集 コイン集め 코인모으기' },
    { id: 'buccaneer_bay',         description: 'multiplayer pirate sea adventure sea of thieves style ship sailing cannon combat treasure hunt kraken islands open ocean 海盗 パイレーツ 해적 โจรสลัด' },
    { id: 'pickaxe_keep',          description: 'multiplayer terraria style 2.5D sidescroll mining building survival sandbox dig blocks craft pickaxe sword fight zombies day night cycle ore stone iron diamond 泰拉瑞亚 テラリア 테라리아' },
    { id: 'jelly_jam',             description: 'multiplayer fall guys style party elimination minigame bracket sprint race obstacle course spinning beam dive jump qualify eliminated bracket podium chaotic party game 糖豆人 フォールガイズ 폴가이즈' },
    { id: 'noodle_jaunt',          description: 'multiplayer co-op human fall flat gang beasts style floppy physics puzzle platformer ragdoll character LMB RMB grab climb push button pressure plate cube checkpoint goal flag wobble 人类跌落梦境 ヒューマンフォールフラット' },
    { id: 'pin_pal',               description: 'multiplayer wii sports nintendo switch sports style ten pin bowling turn based 10 frame strike spare gutter aim power meter physics ball pins alley arcade casual sports 保龄球 ボウリング 볼링 โบว์ลิ่ง' },
    { id: 'lawn_defenders',        description: 'single-player plants vs zombies style lane defense tower garden sunflower peashooter cherry bomb wallnut zombie waves sun economy lawn grass home base tile grid 植物大战僵尸 プラントvsゾンビ 식물vs좀비' },
    { id: 'multiplayer_rocket_pitch', description: 'multiplayer rocket league style car football car soccer boost jump ball physics goals kickoff cars arena 2v2 3v3 supersonic acrobatic vehicular rocket pitch 火箭联盟 ロケットリーグ 로켓리그' },
    { id: 'lane_hopper',           description: 'single-player crossy road frogger style endless lane-crossing chicken hop traffic logs rivers coins tile lanes infinite procedural arcade hopper 过马路 クロッシーロード 크로시로드 ข้ามถนน' },
    { id: 'pipe_runner',           description: 'single-player super mario 2.5D side-scrolling platformer jump stomp goombas koopas coins warp pipes flagpole lives time score mushroom powerup 2d platformer 超级马里奥 スーパーマリオ 슈퍼마리오' },
    { id: 'multiplayer_rift_1v1',  description: 'multiplayer 1v1 league of legends mid lane MOBA style hero abilities minions tower gold shop item build nexus last hit solo queue duel 英雄对决 1対1 일대일' },
    { id: 'alien_invasion',        description: 'single-player space invaders galaga style retro fixed-screen shooter arcade laser cannon aliens descending rows UFO score waves classic 8-bit shmup 太空侵略者 スペースインベーダー 스페이스인베이더' },
    { id: 'banner_siege',          description: 'multiplayer capture the flag CTF team objective banner siege two teams red blue bases flag planting stealing rally attack defend team combat 夺旗 キャプチャーザフラッグ 깃발뺏기' },
    { id: 'cellar_purge',          description: 'single-player binding of isaac style top-down twin-stick roguelite dungeon crawler tear projectiles arrow keys WASD rooms zombies boss hearts coins keys pickups basement cellar 以撒的结合 地下城 ローグライク 로그라이크' },
    { id: 'court_clash',           description: 'multiplayer NBA 2K style basketball sports game two teams home away quarters scoreboard shot meter pass steal hoop rim three pointer two pointer baller dribble court arena 篮球 バスケットボール 농구 บาสเก็ตบอล' },
    { id: 'kart_karnival',         description: 'multiplayer mario kart style arcade kart racing circuit laps drift boost item boxes power ups missile banana shield bolt grand prix party racer 8 player 马里奥赛车 マリオカート 마리오카트 แข่งรถมาริโอ' },
    { id: 'kitchen_master',        description: 'single-player cooking mama overcooked solo style kitchen cooking mini-game chop mix fry plate timer recipe stars perfect scoring food prep restaurant chef 做菜烹饪 料理ゲーム 요리게임 เกมทำอาหาร' },
    { id: 'liminal_loop',          description: 'single-player exit 8 style anomaly detection corridor walking simulator subway hallway fluorescent lights spot the difference psychological horror puzzle turn back continue forward 恐怖走廊 ホラー回廊 공포복도' },
    { id: 'multiplayer_neon_cycles', description: 'multiplayer tron light cycles neon bikes arena light wall trail combat best of N rounds turn swerve crash elimination survival wall game 电子摩托 トロン ネオンサイクル 네온사이클' },
    { id: 'multiplayer_zone_royale', description: 'multiplayer top-down battle royale looter shooter surviv.io fortnite io style last one standing storm shrinking loot crates weapons armor heal arena 大逃杀 バトルロイヤル 배틀로얄 เกมเอาชีวิตรอด' },
];

let templateEmbeddings: Map<string, number[]> | null = null;
let initPromise: Promise<void> | null = null;

export function templateIndexReady(): boolean {
    return templateEmbeddings !== null;
}

// Build the embedding corpus by concatenating each template's
// hand-curated description with all of its keyword synonyms. Keywords
// carry the named-franchise hits ("frogger", "tron", "surviv.io") that
// descriptions phrase more generically, so folding them into the
// embedded text lets a single cached vector answer both literal and
// semantic queries.
function buildCorpus(): Array<{ key: string; text: string }> {
    const keywordsByTemplate = new Map<string, string[]>();
    for (const [synonyms, id] of TEMPLATE_KEYWORDS) {
        const bucket = keywordsByTemplate.get(id) ?? [];
        bucket.push(...synonyms);
        keywordsByTemplate.set(id, bucket);
    }
    return TEMPLATES.map(t => {
        const kws = keywordsByTemplate.get(t.id);
        const text = kws && kws.length > 0
            ? `${t.description} ${kws.join(' ')}`
            : t.description;
        return { key: t.id, text };
    });
}

// Idempotent — safe to call multiple times. Concurrent calls share the same
// in-flight promise.
export function initTemplateEmbeddings(): Promise<void> {
    if (initPromise) return initPromise;
    initPromise = (async () => {
        const corpus = buildCorpus();
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
            const queryVec = await embedQuery(description);
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

// Search-UI helper: returns all known template ids ranked by cosine
// similarity against the cached embeddings. Throws if embeddings aren't
// ready so the caller can fall back to keyword/substring matching.
export async function rankTemplatesBySearch(query: string): Promise<Array<{ id: string; score: number }>> {
    if (initPromise) {
        try { await initPromise; } catch { /* fall through */ }
    }
    if (!templateEmbeddings) throw new Error('template embeddings not ready');
    const queryVec = await embedQuery(query);
    const ranked: Array<{ id: string; score: number }> = [];
    for (const [id, vec] of templateEmbeddings) {
        ranked.push({ id, score: cosineSimilarity(queryVec, vec) });
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked;
}

// ─── Keyword fallback ──────────────────────────────────────────────────────
//
// Used while embeddings are still warming up at boot, or as a second-chance
// after embedding misses. Order matters: more specific keywords come first
// so e.g. "multiplayer fps shooter" matches fps_shooter before plain "fps".

export const TEMPLATE_KEYWORDS: Array<[string[], string]> = [
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
