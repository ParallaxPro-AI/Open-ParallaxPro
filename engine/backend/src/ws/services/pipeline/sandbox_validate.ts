/**
 * sandbox_validate.ts — single source of truth for the validation scripts
 * that get dropped into every CLI sandbox (CREATE_GAME + FIX_GAME).
 *
 * Why this module exists: cli_creator and cli_fixer used to each hand-roll
 * their own near-identical `writeValidateScripts`, and the two copies
 * drifted — the fixer's validate.sh was silently missing the assembler
 * check (the strict one that catches unknown event names, active_behaviors
 * typos, etc). Centralising here guarantees parity.
 *
 * What the sandbox gets:
 *   - validate.sh            — bash orchestrator, run by the CLI at the
 *                              end of its turn budget.
 *   - validate_headless.js   — in-process script smoke test (loads every
 *                              behavior/system/scripts TS, runs onStart +
 *                              60 update ticks against stub runtimes).
 *   - validate_assembler.js  — runs the same validation checks as
 *                              assembleGame() in level_assembler.ts,
 *                              entirely offline using the sandbox's
 *                              project/ files. Catches unknown event
 *                              names, missing behavior/system/UI refs,
 *                              active_behaviors / active_systems typos,
 *                              bad FSM transitions, spawnEntity refs,
 *                              UI button refs, hud_update key collisions,
 *                              inline-onclick IIFE scoping issues, and
 *                              invalid asset paths (mesh/audio/texture).
 *                              Never soft-fails — always runs.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname_sv = path.dirname(fileURLToPath(import.meta.url));
const VALIDATE_ASSEMBLER_JS = fs.readFileSync(
    path.join(__dirname_sv, 'validate_assembler_script.js'),
    'utf-8',
);

// Absolute host path of `engine/`. validate.sh substitutes this in for
// __ENGINE_DIR_HOST__ as a non-Docker fallback so `bash validate.sh` can
// run the playtest via `tsx <enginePath>/headless/src/cli.ts` when the
// sandbox image's `/usr/local/bin/playtest` wrapper isn't available
// (i.e. local-host dev without DOCKER_SANDBOX=1).
const ENGINE_DIR_HOST = path.resolve(__dirname_sv, '..', '..', '..', '..', '..');

export function writeValidateScripts(sandboxDir: string): void {
    const sh = VALIDATE_SH.replaceAll('__ENGINE_DIR_HOST__', ENGINE_DIR_HOST);
    fs.writeFileSync(path.join(sandboxDir, 'validate.sh'), sh, { mode: 0o755 });
    fs.writeFileSync(path.join(sandboxDir, 'validate_headless.js'), VALIDATE_HEADLESS_JS);
    fs.writeFileSync(path.join(sandboxDir, 'validate_assembler.js'), VALIDATE_ASSEMBLER_JS);
    fs.writeFileSync(path.join(sandboxDir, 'validate_uihandlers.js'), VALIDATE_UIHANDLERS_JS);
    fs.writeFileSync(path.join(sandboxDir, 'validate_responsive.js'), VALIDATE_RESPONSIVE_JS);
}

/**
 * Write a `search_assets.sh` tool into the sandbox so the CLI can
 * semantically search the asset library without reading the full
 * catalogs. Requires `.search_config.json` (written by cli_creator /
 * cli_fixer) with `{ url, token }`. Soft-fails gracefully when the
 * backend is unreachable — returns empty results, never blocks the run.
 */
export function writeSearchAssetsTool(sandboxDir: string): void {
    fs.writeFileSync(path.join(sandboxDir, 'search_assets.sh'), SEARCH_ASSETS_SH, { mode: 0o755 });
}

/**
 * Write a `library.sh` tool into the sandbox — semantic + lexical
 * search over the game-component library, plus on-demand file fetch.
 * Replaces "read reference/ by hand" with "ask for what you want."
 *
 * Shares the `.search_config.json` with search_assets.sh (same url/token).
 * Backend endpoints live at /api/engine/internal/library/{index,search,file}.
 * Soft-fails gracefully (exit 0 with stderr warning) so a transient
 * backend hiccup doesn't blow up an agent run.
 */
export function writeLibraryTool(sandboxDir: string): void {
    fs.writeFileSync(path.join(sandboxDir, 'library.sh'), LIBRARY_SH, { mode: 0o755 });
}

const SEARCH_ASSETS_SH = `#!/bin/bash
# Semantic asset search — queries the engine backend's embedding index.
#
# Single query:
#   bash search_assets.sh "soldier character model"
#   bash search_assets.sh "footstep sound" --category Audio
#   bash search_assets.sh "grass texture" --limit 10
#
# Batch mode (multiple queries in one call — saves tool-call round trips):
#   bash search_assets.sh "soldier character" "zombie enemy" "gunshot sound" "brick texture"
#
# The "path" field is the value you use in entity defs and scripts, e.g.
#   mesh.asset: "/assets/kenney/models/character/Knight.glb"
#   this.audio.playSound("/assets/kenney/audio/hit.ogg")

if [ -z "\$1" ]; then
    echo "Usage: bash search_assets.sh \\"query1\\" [\\"query2\\" ...] [--category Audio|Textures] [--limit N]"
    exit 1
fi

# Collect queries and flags
QUERIES=()
CATEGORY=""
LIMIT="10"
while [ \$# -gt 0 ]; do
    case "\$1" in
        --category) CATEGORY="\$2"; shift 2 ;;
        --limit) LIMIT="\$2"; shift 2 ;;
        *) QUERIES+=("\$1"); shift ;;
    esac
done

if [ \${#QUERIES[@]} -eq 0 ]; then
    echo "No queries provided."
    exit 1
fi

# Read backend URL + token from config
if [ ! -f .search_config.json ]; then
    echo "WARN: .search_config.json missing — cannot search assets." >&2
    exit 0
fi

URL=\$(node -e "const c=JSON.parse(require('fs').readFileSync('.search_config.json','utf-8'));process.stdout.write(c.url||'')")
FALLBACK_URL=\$(node -e "const c=JSON.parse(require('fs').readFileSync('.search_config.json','utf-8'));process.stdout.write(c.fallbackUrl||'')")
TOKEN=\$(node -e "const c=JSON.parse(require('fs').readFileSync('.search_config.json','utf-8'));process.stdout.write(c.token||'')")

if [ -z "\$URL" ] && [ -z "\$FALLBACK_URL" ]; then
    exit 0
fi

ENCODED_CAT=""
if [ -n "\$CATEGORY" ]; then
    ENCODED_CAT=\$(node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "\$CATEGORY")
fi

for QUERY in "\${QUERIES[@]}"; do
    ENCODED_QUERY=\$(node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "\$QUERY")
    PARAMS="q=\$ENCODED_QUERY&limit=\$LIMIT"
    if [ -n "\$ENCODED_CAT" ]; then
        PARAMS="\$PARAMS&category=\$ENCODED_CAT"
    fi

    RESP=""
    if [ -n "\$URL" ]; then
        RESP=\$(curl -sf --max-time 3 -H "X-Internal-Token: \$TOKEN" "\$URL/api/engine/internal/search-assets?\$PARAMS" 2>/dev/null)
    fi
    if [ -z "\$RESP" ] && [ -n "\$FALLBACK_URL" ]; then
        RESP=\$(curl -sf --max-time 5 -H "X-Internal-Token: \$TOKEN" "\$FALLBACK_URL/api/engine/internal/search-assets?\$PARAMS" 2>/dev/null)
    fi

    if [ -z "\$RESP" ]; then
        echo "[\$QUERY] WARN: endpoint unreachable"
        continue
    fi

    node -e "
var data = JSON.parse(process.argv[1]);
var q = process.argv[2];
var results = data.results || [];
function fmtVerts(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '';
    if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M verts';
    if (v >= 100000)  return Math.round(v / 1000) + 'K verts';
    if (v >= 1000)    return (v / 1000).toFixed(1) + 'K verts';
    return v + ' verts';
}
if (results.length === 0) { console.log('[' + q + '] No results.'); }
else {
    console.log('[' + q + '] ' + results.length + ' result(s):');
    for (var r of results) {
        // Canonical size in meters (W × H × D after MODEL_FACING.json scale).
        // Use it to plan placements: spacing >= max width avoids overlap,
        // height tells you whether to clear it with a jump, etc.
        var sz = '';
        if (Array.isArray(r.size) && r.size.length === 3) {
            sz = '  ' + r.size[0].toFixed(2) + 'x' + r.size[1].toFixed(2) + 'x' + r.size[2].toFixed(2) + 'm';
        }
        // Vertex count is roughly proportional to GPU vertex-shader work
        // and per-mesh VRAM. Useful when picking between similar visuals
        // for assets you'll instantiate many copies of (props, enemies);
        // single hero meshes can comfortably go higher. See CREATOR_CONTEXT
        // / FIXER_CONTEXT vertex budget guidelines for rules of thumb.
        var vc = '';
        if (typeof r.vertices === 'number') vc = '  [' + fmtVerts(r.vertices) + ']';
        // Community/AI-generated assets have opaque random-hex paths that
        // tell the AI nothing — surface the original prompt as the
        // readable label so it can pick the right one.
        var desc = '';
        if (typeof r.description === 'string' && r.description.length > 0) {
            var d = r.description.length > 120 ? r.description.slice(0, 117) + '...' : r.description;
            desc = '  — "' + d.replace(/"/g, '\\\\"') + '"';
        }
        console.log('  ' + r.path + '  (' + r.category + ', ' + r.pack + ')' + sz + vc + desc);
    }
}
" "\$RESP" "\$QUERY"
done
`;

const LIBRARY_SH = `#!/bin/bash
# library.sh — on-demand access to the reusable game-components library.
#
# Subcommands:
#
#   list [KIND]
#       Show the library index. KIND is one of behaviors | systems | ui |
#       templates. When KIND is omitted, prints all four. Each entry
#       carries a one-line summary so you can usually pick the right
#       file without opening it.
#
#   search "QUERY" ["QUERY2" ...] [--kind K] [--category C] [--limit N]
#       Semantic + lexical hybrid search. Multiple queries run in a
#       single call — batch whenever you have related intents, it's
#       cheaper for your transcript than N separate calls. Returns
#       top-N ranked hits per query.
#
#       Examples:
#         bash library.sh search "platformer jumping"
#         bash library.sh search "zombie AI" "health regen" "boss fight"
#         bash library.sh search "tower ai" --kind behaviors --limit 5
#         bash library.sh search "movement" --category movement
#
#   show PATH [PATH2 ...]
#       Fetch one or more library files. Kind-inferring: literal
#       references inside library files (like "movement/jump.ts" in a
#       template's 02_entities.json) resolve without needing the kind
#       prefix. Accepts:
#         behaviors/movement/jump.ts     (explicit kind)
#         movement/jump.ts               (kind inferred from .ts)
#         gameplay/scoring.ts            (resolves to systems/)
#         hud/health.html                (ui)
#         hud/health                     (no extension → ui/hud/health.html)
#         templates/platformer           (all 4 JSONs concatenated)
#         platformer                     (no extension → template id)
#
#       Multiple paths return concatenated with "=== <resolved-path> ==="
#       headers. Anything not found becomes "=== NOT_FOUND: ... ===" in
#       line, so one call covers partial failures.
#
#       Slice flags (single-path only — multi-path ignores them):
#         --head N          first N lines
#         --tail N          last N lines
#         --range L1-L2     lines L1 through L2 (1-based, inclusive)
#       These are cheaper than fetching the whole file then piping to
#       head/tail — the server slices before sending, so the transcript
#       only holds what was asked for.
#
#   examples QUERY [--limit N]
#       Grep-style search: find files where QUERY appears literally,
#       return file:line + a few lines of context. Use when you want
#       to see HOW an API is called in the shipped code, not to find
#       files by intent (that's \`search\`).
#
#       Examples:
#         bash library.sh examples playSound
#         bash library.sh examples scene.events.net.emit
#         bash library.sh examples lightType --limit 20
#
#       Empty results mean no library file or template uses QUERY
#       literally — check CREATOR_CONTEXT.md for the API's docs.
#
#   grep PATTERN [--kind K] [--category C] [-i] [-l] [--limit N] [--context N]
#       Real-regex sibling of \`examples\`. Where \`examples\` matches a
#       literal substring (no escaping needed for \`.\` \`(\` etc),
#       \`grep\` compiles PATTERN as a JS RegExp so you can express
#       alternation, anchors, character classes, repetition. Use when
#       a literal substring won't separate signal from noise.
#
#       Flags:
#         -i, --ignore-case    case-insensitive match
#         -l, --files-only     return file paths + match counts, no snippets
#         --kind K             scope to behaviors | systems | ui | templates
#         --category C         scope to a subdirectory inside a kind
#         --limit N            max hits (default 15, max 40)
#         --context N          lines of context around each match (default 2, max 6)
#
#       Examples:
#         bash library.sh grep 'events\\.(ui|game)\\.(emit|on)\\('
#         bash library.sh grep '^export class \\w+System' --kind systems
#         bash library.sh grep 'playAnimation\\([^)]*"(Walk|Run)"'
#         bash library.sh grep 'TODO|FIXME' --files-only
#
#       Use SINGLE quotes around PATTERN. Double quotes let bash mangle
#       backslashes — single quotes pass the regex through untouched.
#
#   animations <asset_path> [<asset_path2> ...]
#       List the animation clip names baked into one or more GLB
#       assets. Use BEFORE writing entity.playAnimation("X", ...) calls
#       so X is guaranteed to be a real clip on the chosen GLB.
#       Different GLBs ship different clip vocabularies — Quaternius
#       characters might have Punch/Kick/Run, robots might only have
#       Idle/Walk/Death. The animation_clip_resolves invariant catches
#       missing clips at gate time, but checking up-front saves a
#       retry round-trip.
#
#       Asset paths take the same form 02_entities.json uses:
#         /assets/quaternius/characters/ultimate_animated_character_pack/Kimono_Male.glb
#
#       Output is one clip name per line under a "=== <path> ===" header.
#
# Soft-fails gracefully if the engine backend is unreachable — writes a
# warning to stderr and exits 0 so a CREATE_GAME run isn't broken by a
# transient. Reads URL + token from .search_config.json (same file the
# search_assets tool uses).

CMD="\$1"
shift 2>/dev/null || true

if [ -z "\$CMD" ] || [ "\$CMD" = "help" ] || [ "\$CMD" = "-h" ] || [ "\$CMD" = "--help" ]; then
    # Dump every comment line at the head of the script, stripping the
    # leading "# ". Stop at the first non-comment line (blank or code) so
    # the help auto-extends as new subcommands are documented.
    awk '/^#!/{next} !/^#/{exit} {sub(/^# ?/,""); print}' "\$0"
    exit 0
fi

if [ ! -f .search_config.json ]; then
    echo "WARN: .search_config.json missing — cannot use library tool." >&2
    exit 0
fi

URL=\$(node -e "const c=JSON.parse(require('fs').readFileSync('.search_config.json','utf-8'));process.stdout.write(c.url||'')")
FALLBACK_URL=\$(node -e "const c=JSON.parse(require('fs').readFileSync('.search_config.json','utf-8'));process.stdout.write(c.fallbackUrl||'')")
TOKEN=\$(node -e "const c=JSON.parse(require('fs').readFileSync('.search_config.json','utf-8'));process.stdout.write(c.token||'')")

if [ -z "\$URL" ] && [ -z "\$FALLBACK_URL" ]; then
    echo "WARN: no backend URL in .search_config.json." >&2
    exit 0
fi

enc() { node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "\$1"; }

# Try local engine URL first, then fall back to the public URL (typically
# the prod CDN / main server). On worker hosts where the docker bridge
# can't reach \`host.docker.internal\`, the local URL fails fast and the
# fallback carries the call. Mirrors the URL/FALLBACK_URL pattern that
# search_assets.sh already uses. Echos response body on success; returns
# non-zero only when BOTH attempts fail.
fetch_lib() {
    local rel="\$1"
    local resp
    if [ -n "\$URL" ]; then
        resp=\$(curl -sf --max-time 10 "\${HDR[@]}" "\${URL}/api/engine/internal/\${rel}" 2>/dev/null) && {
            printf '%s' "\$resp"
            return 0
        }
    fi
    if [ -n "\$FALLBACK_URL" ]; then
        resp=\$(curl -sf --max-time 10 "\${HDR[@]}" "\${FALLBACK_URL}/api/engine/internal/\${rel}" 2>/dev/null) && {
            printf '%s' "\$resp"
            return 0
        }
    fi
    return 1
}

# Parse flags from remaining args
POSITIONAL=()
KIND=""
CATEGORY=""
LIMIT=""
HEAD=""
TAIL=""
RANGE=""
IGNORE_CASE=""
FILES_ONLY=""
CONTEXT_ARG=""
while [ \$# -gt 0 ]; do
    case "\$1" in
        --kind)      KIND="\$2"; shift 2 ;;
        --category)  CATEGORY="\$2"; shift 2 ;;
        --limit)     LIMIT="\$2"; shift 2 ;;
        --head)      HEAD="\$2"; shift 2 ;;
        --tail)      TAIL="\$2"; shift 2 ;;
        --context)   CONTEXT_ARG="\$2"; shift 2 ;;
        -i|--ignore-case) IGNORE_CASE="1"; shift ;;
        -l|--files-only)  FILES_ONLY="1"; shift ;;
        --range)
            RANGE="\$2"; shift 2
            # Normalize \`--range 220 280\` (two space-separated numbers)
            # to the canonical \`--range 220-280\`. Agents frequently try
            # the space form because the flag is described as "L1-L2";
            # they see two numbers, type two args.
            if [[ ! "\$RANGE" =~ - ]] && [[ "\$1" =~ ^[0-9]+\$ ]]; then
                RANGE="\${RANGE}-\$1"; shift
            fi
            ;;
        *)           POSITIONAL+=("\$1"); shift ;;
    esac
done

HDR=(-H "X-Internal-Token: \$TOKEN")

case "\$CMD" in

list)
    QS=""
    if [ \${#POSITIONAL[@]} -gt 0 ]; then
        QS="?kind=\$(enc "\${POSITIONAL[0]}")"
    fi
    RESP=\$(fetch_lib "library/index\${QS}") || {
        echo "WARN: library/index endpoint unreachable." >&2
        exit 0
    }
    node -e "
var data = JSON.parse(process.argv[1]);
function suffix(k) {
  if (k === 'ui') return '.html';
  if (k === 'templates') return '';
  return '.ts';
}
function byCategory(items) {
  var g = {};
  for (var it of items) (g[it.category] ||= []).push(it);
  return g;
}
function dumpKind(kind, items) {
  // Cap per-category output — agents rarely need every entry of every
  // category. Over the cap, print the first CAT_CAP and a hint to drill
  // down with search or --category.
  var CAT_CAP = 20;
  console.log(kind.charAt(0).toUpperCase() + kind.slice(1) + ' (' + items.length + ' total)');
  var g = byCategory(items);
  for (var cat of Object.keys(g).sort()) {
    if (cat === '_root') console.log('  (root)');
    else console.log('  ' + cat + '/');
    var bucket = g[cat];
    var shown = bucket.slice(0, CAT_CAP);
    for (var it of shown) {
      var name = it.name + suffix(kind);
      var sum = (it.summary || '').slice(0, 100);
      var line = '    ' + name;
      while (line.length < 42) line += ' ';
      if (sum) line += ' — ' + sum;
      console.log(line);
    }
    if (bucket.length > CAT_CAP) {
      console.log('    … and ' + (bucket.length - CAT_CAP) + ' more — use search or --category ' + cat);
    }
  }
}
function terseSummary() {
  // Unscoped list without a kind arg gets a counts-only summary so the
  // agent can orient cheaply. Full per-kind dumps are large (20K+
  // tokens) and almost never all-needed at once. All strings below use
  // single quotes intentionally: this JS is interpolated into an outer
  // bash double-quoted node invocation, so a stray double quote would
  // end the bash string. Backticks inside this comment would ALSO
  // trigger bash command substitution, so avoid those too.
  function line(label, items) {
    var cats = new Set();
    for (var it of items) cats.add(it.category);
    var catStr = cats.size === 1 && cats.has('_root') ? '' : ' across ' + cats.size + ' cats';
    console.log('  ' + label.padEnd(11) + items.length.toString().padEnd(4) + ' file' + (items.length === 1 ? ' ' : 's') + catStr);
  }
  console.log('Library summary:');
  line('behaviors', data.behaviors);
  line('systems',   data.systems);
  line('ui',        data.ui);
  line('templates', data.templates);
  console.log();
  console.log('Next steps:');
  console.log('  library.sh list <kind>   drill into one kind with per-file summaries');
  console.log('                           kind = behaviors | systems | ui | templates');
  console.log('  library.sh search <q>    semantic search across the whole library');
}
if (data.kind) dumpKind(data.kind, data.items);
else terseSummary();
" "\$RESP"
    ;;

search)
    if [ \${#POSITIONAL[@]} -eq 0 ]; then
        echo "Usage: library.sh search \\"query\\" [\\"query2\\" ...] [--kind K] [--category C] [--limit N]" >&2
        exit 1
    fi
    QS=""
    for q in "\${POSITIONAL[@]}"; do
        [ -n "\$QS" ] && QS="\${QS}&"
        QS="\${QS}q=\$(enc "\$q")"
    done
    [ -n "\$KIND" ]     && QS="\${QS}&kind=\$(enc "\$KIND")"
    [ -n "\$CATEGORY" ] && QS="\${QS}&category=\$(enc "\$CATEGORY")"
    [ -n "\$LIMIT" ]    && QS="\${QS}&limit=\${LIMIT}"

    RESP=\$(fetch_lib "library/search?\${QS}") || {
        echo "WARN: library/search endpoint unreachable." >&2
        exit 0
    }
    node -e "
var data = JSON.parse(process.argv[1]);
function fmt(q, hits) {
  console.log('[' + q + '] ' + hits.length + ' match' + (hits.length === 1 ? '' : 'es'));
  if (!hits.length) return;
  for (var h of hits) {
    var sum = (h.summary || '').slice(0, 80);
    var kind = h.kind.padEnd(9);
    var rel = h.relPath.padEnd(38);
    console.log('  ' + h.score.toFixed(2) + '  ' + kind + ' ' + rel + (sum ? ' — ' + sum : ''));
  }
}
if (data.batch) {
  for (var i = 0; i < data.results.length; i++) {
    if (i > 0) console.log();
    fmt(data.results[i].query, data.results[i].hits);
  }
} else {
  fmt(data.query, data.hits);
}
" "\$RESP"
    ;;

show)
    if [ \${#POSITIONAL[@]} -eq 0 ]; then
        echo "Usage: library.sh show PATH [PATH2 ...] [--head N | --tail N | --range L1-L2]" >&2
        exit 1
    fi
    QS=""
    for p in "\${POSITIONAL[@]}"; do
        [ -n "\$QS" ] && QS="\${QS}&"
        QS="\${QS}path=\$(enc "\$p")"
    done
    # Slice flags — only applied server-side for single-path shows.
    # Multi-path responses ignore them (one slice across a concatenated
    # blob of multiple files would be ambiguous).
    [ -n "\$HEAD" ]  && QS="\${QS}&head=\${HEAD}"
    [ -n "\$TAIL" ]  && QS="\${QS}&tail=\${TAIL}"
    [ -n "\$RANGE" ] && QS="\${QS}&range=\$(enc "\$RANGE")"
    # Single-path returns raw content; multi-path returns concatenated text.
    # Split body from HTTP status so we can distinguish "path doesn't
    # exist" (404, agent-actionable) from "backend unreachable" (network
    # failure, run should soft-fail). On 404 we synthesise the same
    # "=== NOT_FOUND: ... ===" marker that multi-path already uses, so
    # the agent sees a consistent error shape across single and multi.
    BODY_FILE=\$(mktemp 2>/dev/null || echo /tmp/libsh.\$\$.body)
    HTTP="000"
    if [ -n "\$URL" ]; then
        HTTP=\$(curl -s --max-time 10 -o "\$BODY_FILE" -w "%{http_code}" "\${HDR[@]}" "\${URL}/api/engine/internal/library/file?\${QS}" 2>/dev/null) || HTTP="000"
    fi
    # Only retry via fallback on a true network failure. A 404 means the
    # path really doesn't exist and the local backend already answered —
    # retrying a mirror would just double-404 for no reason.
    if { [ "\$HTTP" = "000" ] || [ -z "\$HTTP" ]; } && [ -n "\$FALLBACK_URL" ]; then
        HTTP=\$(curl -s --max-time 10 -o "\$BODY_FILE" -w "%{http_code}" "\${HDR[@]}" "\${FALLBACK_URL}/api/engine/internal/library/file?\${QS}" 2>/dev/null) || HTTP="000"
    fi
    if [ "\$HTTP" = "000" ] || [ -z "\$HTTP" ]; then
        echo "WARN: library/file endpoint unreachable." >&2
    elif [ "\$HTTP" = "404" ]; then
        # Backend's 404 body is JSON: {"error":"not_found","tried":[...]}
        TRIED=\$(node -e "try { var d = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.stdout.write((d.tried||[]).join(', ')); } catch { process.stdout.write(''); }" "\$BODY_FILE")
        REQ="\${POSITIONAL[*]}"
        echo "=== NOT_FOUND: \${REQ} (tried: \${TRIED}) ==="
    elif [ "\$HTTP" = "200" ]; then
        cat "\$BODY_FILE"
        # Nudge the agent to batch on next call. Single-path shows are the
        # most-common failed-batching pattern — agents issue 5 separate
        # show calls when one batched call would do. stderr so it never
        # contaminates content the agent might redirect to a file.
        if [ \${#POSITIONAL[@]} -eq 1 ]; then
            echo "# tip: batch next time — \\\`library.sh show p1 p2 p3\\\` in one call (one cache_read instead of N)" >&2
        fi
    else
        echo "WARN: library/file returned HTTP \$HTTP." >&2
        head -c 400 "\$BODY_FILE" >&2
        echo >&2
    fi
    rm -f "\$BODY_FILE"
    ;;

animations)
    if [ \${#POSITIONAL[@]} -eq 0 ]; then
        echo "Usage: library.sh animations <asset_path> [<asset_path2> ...]" >&2
        echo "" >&2
        echo "Look up animation clip names baked into one or more GLB assets." >&2
        echo "Use the same path form 02_entities.json uses, e.g." >&2
        echo "  /assets/quaternius/characters/ultimate_animated_character_pack/Kimono_Male.glb" >&2
        echo "" >&2
        echo "Use this BEFORE writing entity.playAnimation(\\"X\\", ...) calls so X is a real clip." >&2
        echo "The animation_clip_resolves invariant catches missing clips, but checking up-front" >&2
        echo "saves a retry round-trip." >&2
        exit 1
    fi
    QS=""
    for ASSET in "\${POSITIONAL[@]}"; do
        if [ -n "\$QS" ]; then QS="\${QS}&"; fi
        QS="\${QS}path=\$(enc "\$ASSET")"
    done
    BODY_FILE=\$(mktemp)
    HTTP=\$(curl -s --max-time 10 -o "\$BODY_FILE" -w "%{http_code}" "\${HDR[@]}" "\${URL}/api/engine/internal/library/animations?\${QS}" 2>/dev/null) || HTTP="000"
    if [ "\$HTTP" != "200" ] && [ -n "\$FALLBACK_URL" ] && [ "\$URL" != "\$FALLBACK_URL" ]; then
        HTTP=\$(curl -s --max-time 10 -o "\$BODY_FILE" -w "%{http_code}" "\${HDR[@]}" "\${FALLBACK_URL}/api/engine/internal/library/animations?\${QS}" 2>/dev/null) || HTTP="000"
    fi
    if [ "\$HTTP" = "200" ]; then
        cat "\$BODY_FILE"
    else
        echo "WARN: library/animations endpoint returned HTTP \$HTTP" >&2
        head -c 400 "\$BODY_FILE" >&2
        echo >&2
    fi
    rm -f "\$BODY_FILE"
    ;;

examples)
    if [ \${#POSITIONAL[@]} -eq 0 ]; then
        echo "Usage: library.sh examples QUERY [--limit N]" >&2
        exit 1
    fi
    QS="q=\$(enc "\${POSITIONAL[0]}")"
    [ -n "\$LIMIT" ] && QS="\${QS}&limit=\${LIMIT}"
    RESP=\$(fetch_lib "library/examples?\${QS}") || {
        echo "WARN: library/examples endpoint unreachable." >&2
        exit 0
    }
    node -e "
var data = JSON.parse(process.argv[1]);
console.log('[' + data.query + '] ' + data.hits.length + ' example' + (data.hits.length === 1 ? '' : 's'));
if (data.hits.length === 0) {
  console.log('No library file or template uses this literally. If this is a scripting API');
  console.log('(this.scene.*, this.audio.*, LightComponent, etc.) check CREATOR_CONTEXT.md');
  console.log('for its docs — it is described there, not in a library file.');
} else {
  for (var h of data.hits) {
    console.log('');
    console.log('--- ' + h.path + ':' + h.line + ' ---');
    console.log(h.snippet);
  }
}
" "\$RESP"
    ;;

grep)
    if [ \${#POSITIONAL[@]} -eq 0 ]; then
        echo "Usage: library.sh grep PATTERN [--kind K] [--category C] [-i] [-l] [--limit N] [--context N]" >&2
        echo "" >&2
        echo "Real-regex search across the library + templates. Use when 'examples'" >&2
        echo "(literal substring) can't separate signal — e.g. alternation, anchors," >&2
        echo "char classes. PATTERN is a JS RegExp. Wrap in SINGLE quotes so bash" >&2
        echo "doesn't strip your backslashes." >&2
        exit 1
    fi
    QS="pattern=\$(enc "\${POSITIONAL[0]}")"
    [ -n "\$KIND" ]        && QS="\${QS}&kind=\$(enc "\$KIND")"
    [ -n "\$CATEGORY" ]    && QS="\${QS}&category=\$(enc "\$CATEGORY")"
    [ -n "\$LIMIT" ]       && QS="\${QS}&limit=\${LIMIT}"
    [ -n "\$CONTEXT_ARG" ] && QS="\${QS}&context=\${CONTEXT_ARG}"
    [ -n "\$IGNORE_CASE" ] && QS="\${QS}&ignoreCase=1"
    [ -n "\$FILES_ONLY" ]  && QS="\${QS}&filesOnly=1"

    # Direct curl (not fetch_lib) so we can read 400 bodies — the bad-regex
    # detail message lives in the 400 body and curl -sf would swallow it.
    BODY_FILE=\$(mktemp 2>/dev/null || echo /tmp/libsh.\$\$.body)
    HTTP="000"
    if [ -n "\$URL" ]; then
        HTTP=\$(curl -s --max-time 10 -o "\$BODY_FILE" -w "%{http_code}" "\${HDR[@]}" "\${URL}/api/engine/internal/library/grep?\${QS}" 2>/dev/null) || HTTP="000"
    fi
    # Only retry on a true network failure. 400 (bad regex) is the agent's
    # bug, and 200 with no hits is conclusive — neither benefits from a
    # mirror retry.
    if { [ "\$HTTP" = "000" ] || [ -z "\$HTTP" ]; } && [ -n "\$FALLBACK_URL" ]; then
        HTTP=\$(curl -s --max-time 10 -o "\$BODY_FILE" -w "%{http_code}" "\${HDR[@]}" "\${FALLBACK_URL}/api/engine/internal/library/grep?\${QS}" 2>/dev/null) || HTTP="000"
    fi

    if [ "\$HTTP" = "000" ] || [ -z "\$HTTP" ]; then
        echo "WARN: library/grep endpoint unreachable." >&2
        rm -f "\$BODY_FILE"
        exit 0
    fi
    if [ "\$HTTP" = "400" ]; then
        node -e "try { var d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); console.error('ERROR (bad regex): ' + (d.detail || d.error || 'invalid pattern')); } catch (e) { console.error('ERROR: bad request'); }" "\$BODY_FILE"
        rm -f "\$BODY_FILE"
        exit 1
    fi
    if [ "\$HTTP" != "200" ]; then
        echo "WARN: library/grep returned HTTP \$HTTP" >&2
        head -c 400 "\$BODY_FILE" >&2
        echo >&2
        rm -f "\$BODY_FILE"
        exit 0
    fi

    node -e "
var data = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
var label = '/' + data.pattern + '/' + (data.flags || '');
var trunc = data.truncated ? ' (truncated — refine with --kind/--category or tighten the pattern)' : '';
if (data.files) {
  console.log('[' + label + '] ' + data.files.length + ' file' + (data.files.length === 1 ? '' : 's') + trunc);
  for (var f of data.files) {
    var n = f.count.toString();
    while (n.length < 3) n = ' ' + n;
    console.log('  ' + n + '  ' + f.path);
  }
} else {
  console.log('[' + label + '] ' + data.hits.length + ' match' + (data.hits.length === 1 ? '' : 'es') + trunc);
  if (data.hits.length === 0) {
    console.log('No matches. Tips:');
    console.log('  - Wrap PATTERN in single quotes so bash leaves backslashes alone.');
    console.log('  - Try -i for case-insensitive, or relax anchors.');
    console.log('  - For a literal substring, library.sh examples is cheaper.');
  } else {
    for (var h of data.hits) {
      console.log('');
      console.log('--- ' + h.path + ':' + h.line + ' ---');
      console.log(h.snippet);
    }
  }
}
" "\$BODY_FILE"
    rm -f "\$BODY_FILE"
    ;;

*)
    echo "Unknown command: \$CMD" >&2
    echo "Run 'library.sh --help' for usage." >&2
    exit 1
    ;;
esac
`;

// ─── In-process checks ────────────────────────────────────────────────────
//
// These three exported functions are the authoritative spec for what
// validate.sh does (minus the strict assembler check, which callers run
// separately by invoking assembleGame directly). They're meant to be called
// from boot-time template_health.ts so the shipped-template sweep applies
// the exact same rules the CLI sees in its sandbox. The bash/node strings
// below (VALIDATE_SH + VALIDATE_HEADLESS_JS) are mirror copies — if you
// change a check here, update the inline script to match. They're kept in
// the same file so a reviewer can diff them at a glance.
//
// `projectDir` is the directory that holds `01_flow.json` etc. — for a CLI
// sandbox that's `${sandboxDir}/project`; for a shipped template it's the
// template folder itself.

const TEMPLATE_JSONS = ['01_flow.json', '02_entities.json', '03_worlds.json', '04_systems.json'];

export function checkTemplateJSON(projectDir: string): string[] {
    const errors: string[] = [];
    for (const f of TEMPLATE_JSONS) {
        const full = path.join(projectDir, f);
        if (!fs.existsSync(full)) {
            errors.push(`MISSING ${f}`);
            continue;
        }
        try {
            JSON.parse(fs.readFileSync(full, 'utf-8'));
        } catch (e: any) {
            errors.push(`JSON ERROR in ${f}: ${e?.message || e}`);
        }
    }
    return errors;
}

function stripForSyntaxCheck(src: string): string {
    return src
        .replace(/^\s*export\s+default\s+/gm, '')
        .replace(/^\s*export\s+/gm, '')
        .replace(/^\s*import\s+.*$/gm, '')
        .replace(/\bconst\b/g, 'var')
        .replace(/(?:var|let)\s+(\w+)\s*:\s*[^=\n]+=/g, 'var $1 =');
}

export function checkScriptSyntax(projectDir: string): string[] {
    const errors: string[] = [];
    for (const dir of ['behaviors', 'systems', 'scripts']) {
        walkTsFiles(path.join(projectDir, dir), (full, rel) => {
            const src = stripForSyntaxCheck(fs.readFileSync(full, 'utf-8'));
            try {
                // eslint-disable-next-line no-new-func
                new Function('GameScript', 'Vec3', 'Quat', src + '\n;');
            } catch (e: any) {
                errors.push(`SYNTAX ERROR in ${dir}/${rel}: ${e?.message || e}`);
            }
        });
    }
    return errors;
}

const BROWSER_ONLY_RE = /document|window|canvas|AudioContext|WebSocket|fetch|pointerLock/i;

export function runHeadlessSmoke(projectDir: string): string[] {
    const scripts: Record<string, string> = {};
    for (const dir of ['behaviors', 'systems', 'scripts']) {
        walkTsFiles(path.join(projectDir, dir), (full, rel) => {
            scripts[`${dir}/${rel}`] = fs.readFileSync(full, 'utf-8');
        });
    }
    const errors: string[] = [];
    for (const [key, source] of Object.entries(scripts)) {
        try {
            const m = source.match(/class\s+(\w+)/);
            if (!m) {
                // No class → already covered by checkScriptSyntax; skip smoke.
                continue;
            }
            const fn = new Function('GameScript', 'Vec3', 'Quat', stripForSyntaxCheck(source) + '\nreturn ' + m[1] + ';');
            const Cls = fn(StubGameScript, StubVec3, StubQuat);
            const inst = new Cls();
            seedScriptFields(inst);
            if (typeof inst.onStart === 'function') inst.onStart();
            for (let i = 0; i < 60; i++) {
                inst.time = { time: i / 60, deltaTime: 1 / 60, frameCount: i };
                if (typeof inst.onUpdate === 'function') inst.onUpdate(1 / 60);
            }
        } catch (e: any) {
            const msg = e?.message || String(e);
            if (!BROWSER_ONLY_RE.test(msg)) {
                errors.push(`${key}: ${msg}`);
            }
        }
    }
    return errors;
}

/**
 * Lint `events.ui.on("ui_event:...", function(d) { ... })` handlers for the
 * envelope-shape foot-gun: the handler argument is the FULL postMessage
 * envelope `{type, action, panel, data}`, but agents repeatedly write
 * `d.recipeId` thinking they get the inner data — which silently returns
 * `undefined`. The bug is invisible at smoke-test time (the handler runs
 * fine, just does nothing) and a nightmare to diagnose at play-time
 * because hover effects still work (the click event reaches the panel,
 * the message is sent, the bridge invokes the handler, the handler reads
 * the wrong field — every layer looks healthy).
 *
 * Heuristic: for every `events.ui.on("ui_event:...", function(<p>) { ... })`
 * we scan the body for `<p>.<field>` accesses where `<field>` isn't on
 * the envelope's allowlist (`data`, `action`, `panel`, `type`). Any such
 * access is almost certainly the bug.
 */
const UI_EVENT_ENVELOPE_KEYS = new Set(['data', 'action', 'panel', 'type']);

export function checkUiEventHandlers(projectDir: string): string[] {
    const errors: string[] = [];
    for (const dir of ['systems', 'behaviors', 'scripts']) {
        walkTsFiles(path.join(projectDir, dir), (full, rel) => {
            const src = fs.readFileSync(full, 'utf-8');
            const fileErrs = lintUiEventHandlerSource(src);
            for (const e of fileErrs) errors.push(`${dir}/${rel}: ${e}`);
        });
    }
    return errors;
}

function lintUiEventHandlerSource(src: string): string[] {
    const errors: string[] = [];
    // Match `events.ui.on("ui_event:<name>", function(<param>) {`
    const re = /events\.ui\.on\(\s*["'](ui_event:[^"']+)["']\s*,\s*function\s*\(\s*(\w+)\s*\)\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
        const eventName = m[1];
        const param = m[2];
        // Brace-balance to find the function body.
        let depth = 1;
        let i = re.lastIndex;
        while (i < src.length && depth > 0) {
            const c = src[i++];
            if (c === '{') depth++;
            else if (c === '}') depth--;
        }
        const body = src.slice(re.lastIndex, i - 1);
        // Find every `<param>.<field>` access in the body.
        const accessRe = new RegExp('\\b' + param + '\\.([a-zA-Z_]\\w*)', 'g');
        const flagged = new Set<string>();
        let am: RegExpExecArray | null;
        while ((am = accessRe.exec(body)) !== null) {
            const field = am[1];
            if (!UI_EVENT_ENVELOPE_KEYS.has(field)) flagged.add(field);
        }
        if (flagged.size > 0) {
            const fields = Array.from(flagged).map(f => `${param}.${f}`).join(', ');
            errors.push(
                `UI_EVENT envelope misuse in handler for "${eventName}": reads ${fields} ` +
                `from the envelope. Panel-specific fields are nested under ${param}.data — ` +
                `e.g. \`var dd = (${param} && ${param}.data) || {}; dd.${Array.from(flagged)[0]}\`. ` +
                `See CREATOR_CONTEXT.md → "Reading a data payload from a panel".`
            );
        }
    }
    return errors;
}

function walkTsFiles(dir: string, visit: (fullPath: string, relPath: string) => void, prefix = ''): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkTsFiles(full, visit, prefix + entry.name + '/');
        } else if (entry.name.endsWith('.ts')) {
            try { visit(full, prefix + entry.name); } catch {}
        }
    }
}

/**
 * Retry / Game-Over wiring — auto-heal + validate.
 *
 * Targets the two specific failure modes user complaints map to:
 *   (a) Play Again button transitions back to gameplay but doesn't
 *       reset state — score / lives / spawned entities carry over
 *       from the previous run ("retry doesn't actually retry").
 *   (b) Play Again button is wired but does nothing because the panel
 *       emits a different action name than the flow listens for.
 *
 * Failure mode (a) is auto-healable: `normalizeRetryFlow` mutates the
 * flow object in place, appending the `restart` action to any
 * Play-Again-shaped transition that lacks it. Original `01_flow.json`
 * on disk is untouched — only the in-memory flow that drives the
 * assembled FSM driver. This means existing user games that ship with
 * the bug pick up the fix automatically on their next build.
 *
 * Failure mode (b) is NOT auto-healable — we don't know what the user
 * meant. `checkRetryFlowWiring` returns it as a hard error.
 *
 * "Play-Again-shaped" = a transition with `when: "ui_event:<panel>:<a>"`
 * where `<a>` matches `play_again` / `retry` / `restart` / `new_game`
 * / `new_match` / `again` / `replay`. Per-life respawn states
 * (timer-based auto-transitions out of `death_pause` / `wasted` /
 * `death_respawn`) are deliberately untouched — those legitimately
 * keep partial state since the player is losing a life, not finishing
 * the run.
 */
const PLAY_AGAIN_ACTION_RE = /^(play_again|playagain|retry|restart|new_game|new_match|again|replay)$/i;

interface FlowState {
    transitions?: Array<{ when?: string; goto?: string | string[]; actions?: string[] }>;
    on_enter?: any[];
    on_exit?: any[];
    substates?: Record<string, FlowState>;
    [k: string]: any;
}

/**
 * Walk the flow's states and append `restart` to every Play-Again-shaped
 * transition's `actions` array if it's missing. Mutates `flow` in place.
 * Returns the number of transitions healed (for logging / debugging).
 */
export function normalizeRetryFlow(flow: any): number {
    if (!flow?.states) return 0;
    let healed = 0;

    function transitionHasRestart(t: { actions?: any[] }): boolean {
        const acts = t.actions || [];
        return acts.some((a: any) => a === 'restart' || a === 'emit:game.restart_game');
    }

    function walk(states: Record<string, FlowState>) {
        for (const s of Object.values(states)) {
            for (const t of s.transitions || []) {
                const w = t.when || '';
                if (!w.startsWith('ui_event:')) continue;
                const parts = w.slice('ui_event:'.length).split(':');
                if (parts.length < 2) continue;
                const action = parts[1];
                if (!PLAY_AGAIN_ACTION_RE.test(action)) continue;
                if (transitionHasRestart(t)) continue;
                t.actions = [...(t.actions || []), 'restart'];
                healed++;
            }
            if (s.substates) walk(s.substates);
        }
    }
    walk(flow.states);
    return healed;
}

/**
 * Hard-error check for things the assembler can't auto-heal — currently
 * just panel-button-name mismatches. Returns a list of error messages;
 * callers throw if non-empty.
 */
export function checkRetryFlowWiring(projectDir: string): string[] {
    const errors: string[] = [];
    const flowPath = path.join(projectDir, '01_flow.json');
    if (!fs.existsSync(flowPath)) return errors;
    let flow: any;
    try { flow = JSON.parse(fs.readFileSync(flowPath, 'utf-8')); } catch { return errors; }
    if (!flow?.states) return errors;

    // Collect panel emits: every emit('<action>') literal in ui/*.html.
    const uiDir = path.join(projectDir, 'ui');
    const panelEmits = new Map<string, Set<string>>();
    if (fs.existsSync(uiDir)) {
        const collect = (dir: string, prefix = '') => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    collect(full, prefix + e.name + '/');
                } else if (e.name.endsWith('.html')) {
                    const key = prefix + e.name.replace(/\.html$/, '');
                    let src: string;
                    try { src = fs.readFileSync(full, 'utf-8'); } catch { continue; }
                    const found = new Set<string>();
                    const re = /emit\s*\(\s*['"`]([^'"`]+)['"`]\s*[,)]/g;
                    let m: RegExpExecArray | null;
                    while ((m = re.exec(src)) !== null) found.add(m[1]);
                    panelEmits.set(key, found);
                }
            }
        };
        try { collect(uiDir); } catch {}
    }

    function walk(states: Record<string, FlowState>) {
        for (const [name, s] of Object.entries(states)) {
            for (const t of s.transitions || []) {
                const w = t.when || '';
                if (!w.startsWith('ui_event:')) continue;
                const parts = w.slice('ui_event:'.length).split(':');
                if (parts.length < 2) continue;
                const panel = parts[0];
                const action = parts[1];

                // Panel-button-name wiring check. Panel HTML must
                // emit('<action>') literally; otherwise the click fires
                // a different action and the transition never matches —
                // silent dead button. Only flagged when the panel
                // exists AND emits at least one action; panels that
                // emit nothing are HUDs / overlays without buttons and
                // are out of scope for this check.
                const emits = panelEmits.get(panel);
                if (emits && emits.size > 0 && !emits.has(action)) {
                    errors.push(
                        `RETRY/UI-WIRING ERROR: flow listens for ui_event:${panel}:${action} (in state "${name}") but ui/${panel}.html never calls emit('${action}'). The button is wired to the wrong action name — pressing it does nothing. Either rename the panel's emit('...') to match, or update the transition's "when" to one of: ${Array.from(emits).map(x => `'${x}'`).join(', ')}.`
                    );
                }
            }
            if (s.substates) walk(s.substates);
        }
    }
    walk(flow.states);

    return errors;
}

function seedScriptFields(inst: any): void {
    inst.entity = {
        id: 0, name: '', active: true, tags: new Set<string>(),
        transform: {
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            scale: { x: 1, y: 1, z: 1 },
            lookAt() {}, setRotationEuler() {},
        },
        getComponent() { return null; },
        playAnimation() {}, setActive() {}, setMaterialColor() {},
        addTag() {}, removeTag() {}, getScript() { return null; },
    };
    inst.scene = {
        events: { game: { on() {}, emit() {} }, ui: { on() {}, emit() {} } },
        findEntityByName() { return null; },
        findEntitiesByName() { return []; },
        findEntitiesByTag() { return []; },
        setPosition() {}, setScale() {}, setRotationEuler() {}, setVelocity() {},
        destroyEntity() {}, createEntity() { return 0; }, spawnEntity() { return null; },
        addComponent() { return null; }, removeComponent() {},
        raycast() { return null; }, screenRaycast() { return null; }, screenPointToGround() { return null; },
        getAllEntities() { return []; },
        setFog() {}, setTimeOfDay() {}, loadScene() {},
        saveData() {}, loadData() { return null; }, deleteData() {}, listSaveKeys() { return []; },
        getTerrainHeight() { return 0; }, getTerrainNormal() { return { x: 0, y: 1, z: 0 }; },
        _fpsYaw: 0, _tpYaw: 0,
        reloadScene() {},
    };
    // Mirror of the real InputSystem (shared/input/input_system.ts). Phantom
    // methods like getKey / getKeyDown / getMouseButton are intentionally
    // omitted so a script that calls them blows up the smoke test rather
    // than passing here and TypeError-ing in the browser.
    inst.input = {
        isKeyDown() { return false; },
        isKeyJustPressed() { return false; },
        isKeyPressed() { return false; },
        isKeyJustReleased() { return false; },
        isKeyReleased() { return false; },
        isMouseButtonDown() { return false; },
        isMouseButtonJustPressed() { return false; },
        isMouseButtonJustReleased() { return false; },
        getMousePosition() { return { x: 0, y: 0 }; },
        getMouseX() { return 0; }, getMouseY() { return 0; },
        getMouseDelta() { return { x: 0, y: 0 }; },
        getMouseDeltaX() { return 0; }, getMouseDeltaY() { return 0; },
        getScrollDelta() { return { x: 0, y: 0 }; },
        getModifiers() { return {}; },
        getGamepadAxis() { return 0; },
        isGamepadButtonDown() { return false; },
        requestPointerLock() {}, exitPointerLock() {}, isPointerLocked() { return false; },
    };
    inst.ui = {
        createText() { return { text: '', remove() {}, x: 0, y: 0 }; },
        createPanel() { return { remove() {} }; },
        createButton() { return { remove() {} }; },
        createImage() { return { remove() {} }; },
        sendState() {},
    };
    inst.audio = { playSound() {}, playMusic() {}, stopMusic() {}, setGroupVolume() {}, getGroupVolume() { return 1; }, preload() {} };
    inst.time = { time: 0, deltaTime: 1 / 60, frameCount: 0 };
}

class StubGameScript {}
class StubVec3 {
    x: number; y: number; z: number;
    constructor(x?: number, y?: number, z?: number) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }
}
class StubQuat {
    x: number; y: number; z: number; w: number;
    constructor(x?: number, y?: number, z?: number, w?: number) { this.x = x || 0; this.y = y || 0; this.z = z || 0; this.w = w !== undefined ? w : 1; }
}

const VALIDATE_SH = `#!/bin/bash
# Validate template JSON, scripts, run a headless smoke, then hit the
# backend's strict assembler. A single authoritative pipeline used by
# both CREATE_GAME and FIX_GAME sandboxes.
ERRORS=0

echo "=== Template JSON Check ==="
for f in project/01_flow.json project/02_entities.json project/03_worlds.json project/04_systems.json; do
    [ -f "$f" ] || { echo "MISSING $f"; ERRORS=$((ERRORS+1)); continue; }
    node -e "JSON.parse(require('fs').readFileSync('$f','utf-8'))" 2>&1
    if [ $? -ne 0 ]; then echo "JSON ERROR in $f"; ERRORS=$((ERRORS+1)); fi
done

echo "=== Script Syntax Check ==="
for f in $(find project/behaviors project/systems project/scripts -name '*.ts' 2>/dev/null); do
    node -e "
        const fs = require('fs');
        let src = fs.readFileSync('$f', 'utf-8');
        src = src.replace(/^\\s*export\\s+default\\s+/gm, '').replace(/^\\s*export\\s+/gm, '').replace(/^\\s*import\\s+.*$/gm, '').replace(/\\bconst\\b/g, 'var').replace(/(?:var|let)\\s+(\\w+)\\s*:\\s*[^=\\n]+=/g, 'var $1 =');
        try { new Function('GameScript', 'Vec3', 'Quat', src + '\\n;'); }
        catch(e) { console.error('SYNTAX ERROR in $f: ' + e.message); process.exit(1); }
    " 2>&1
    if [ $? -ne 0 ]; then ERRORS=$((ERRORS+1)); fi
done

echo "=== Headless Smoke Test ==="
node validate_headless.js 2>&1
if [ $? -ne 0 ]; then ERRORS=$((ERRORS+1)); fi

echo "=== UI Event Handler Lint ==="
# Catches the envelope-shape foot-gun: handlers that read d.someField when
# the panel-specific data is actually nested under d.data.someField. Bug
# is invisible at smoke-test time and presents as "clicks do nothing"
# while hover effects still work (because the click event reaches the
# panel fine — the handler just reads undefined). Mirror of
# checkUiEventHandlers() in sandbox_validate.ts.
node validate_uihandlers.js 2>&1
if [ $? -ne 0 ]; then ERRORS=$((ERRORS+1)); fi

echo "=== UI Responsive Check ==="
# Every HTML panel under project/ui/ MUST declare
# <meta name="pp-responsive" content="1">. Without it the engine renders
# the panel at a 1920px design width and scales down to ~21% on a phone —
# Apple App Store rejects games whose mobile UI is illegible. The
# CREATOR_CONTEXT/FIXER_CONTEXT "Cross-platform UI" sections cover the
# required pattern and the available CSS variables.
node validate_responsive.js 2>&1
if [ $? -ne 0 ]; then ERRORS=$((ERRORS+1)); fi

echo "=== Assembler Check (strict) ==="
# Runs the same validation as assembleGame() against this project's
# files, plus asset path validation. Catches everything the local
# checks miss: unknown event names, missing behavior/system/UI refs,
# active_behaviors / active_systems name typos, bad FSM transitions,
# spawnEntity refs, UI button refs, hud_update key collisions, and
# invalid mesh/audio/texture asset paths. Runs entirely offline.
node validate_assembler.js 2>&1
if [ $? -ne 0 ]; then ERRORS=$((ERRORS+1)); fi

echo "=== Headless Playtest ==="
# Three resolution paths in priority order:
#   1. /usr/local/bin/playtest — shipped by the agent-sandbox Docker image.
#      Wins inside any DOCKER_SANDBOX=1 container that's been rebuilt.
#   2. tsx against the host engine source — used by local-host dev (no
#      Docker) and any other case where the binary isn't on PATH but the
#      engine source exists at the substituted path. ENGINE_DIR_HOST is
#      resolved at sandbox-creation time by sandbox_validate.writeValidateScripts.
#   3. Skip — final fallback for sandboxes that have neither (e.g. a
#      worker that hasn't rebuilt the image AND can't reach the source).
#      Skip is NOT a failure; the orchestrator-side playtest backstops.
if command -v playtest >/dev/null 2>&1; then
    playtest project/ 2>&1
    PT_RC=$?
elif [ -x "__ENGINE_DIR_HOST__/headless/node_modules/.bin/tsx" ] && [ -f "__ENGINE_DIR_HOST__/headless/src/cli.ts" ]; then
    "__ENGINE_DIR_HOST__/headless/node_modules/.bin/tsx" "__ENGINE_DIR_HOST__/headless/src/cli.ts" project/ 2>&1
    PT_RC=$?
else
    echo "(no playtest available in this sandbox — orchestrator will run it post-CLI)"
    PT_RC=0
fi
if [ $PT_RC -ne 0 ]; then ERRORS=$((ERRORS+1)); fi

if [ $ERRORS -eq 0 ]; then
    echo "All checks passed."
else
    echo "$ERRORS check(s) failed."
    exit 1
fi
`;

// VALIDATE_ASSEMBLER_JS is loaded from validate_assembler_script.js at
// module init time (see top of file). It runs all 8 validation
// categories offline — no HTTP calls, no soft-fails.

// Walks project/ui/**/*.html and fails the build if any panel is missing
// the <meta name="pp-responsive"> opt-in. Without that tag, the engine's
// runtime renders the panel at a 1920px design width and visually scales
// it to ~21% on a phone — text becomes unreadable, which is the exact
// class of issue that triggered the Apple App Store rejection. Every
// shipped template has the tag; the validator catches AI-authored panels
// that diverge from the templates and forget it. See
// CREATOR_CONTEXT.md → "Cross-platform UI".
const VALIDATE_RESPONSIVE_JS = `
const fs = require('fs');
const path = require('path');

const META_RE = /<meta\\s+[^>]*name\\s*=\\s*["']pp-responsive["']/i;

function walk(dir, visit) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, visit);
        else if (entry.name.endsWith('.html')) visit(full);
    }
}

const errors = [];
walk('project/ui', (full) => {
    const src = fs.readFileSync(full, 'utf-8');
    if (!META_RE.test(src)) {
        errors.push(
            full + ': missing <meta name="pp-responsive" content="1">. ' +
            'Every UI panel must declare the responsive opt-in or it will ' +
            'render unreadably small on phones (1920px design-width scale-down). ' +
            'Add the tag at the top of the file, then use ' +
            '@media (pointer: coarse) blocks for mobile-specific overrides ' +
            'and var(--pp-bottom-clear) on bottom-anchored elements to clear ' +
            'the joystick. See CREATOR_CONTEXT.md → "Cross-platform UI".'
        );
    }
});

if (errors.length === 0) {
    console.log('UI responsive check passed.');
} else if (process.env.PP_DEPLOY_REPLAY_SKIP_RESPONSIVE === '1') {
    // check_deploy.sh Phase 4 replays this validator against the latest
    // prod sandbox archive, but archives generated before the responsive
    // opt-in shipped don't carry the meta tag. Skip the hard-fail in
    // that context — engine still renders old panels at the legacy
    // 1920px design-width scale-down, so deploying isn't unsafe — and
    // print the findings so they're still visible. Real CREATE_GAME /
    // FIX_GAME runs don't set this env var; they keep hard-failing.
    console.log('UI responsive check: ' + errors.length + ' panel(s) missing meta tag (deploy-replay context, not blocking):');
    for (const e of errors) console.log('  ' + e);
} else {
    for (const e of errors) console.error(e);
    process.exit(1);
}
`;

// Static lint for \`events.ui.on("ui_event:...", function(d) { ... })\`
// handlers. Mirror of checkUiEventHandlers() in this same file —
// keep the two in sync if you change either.
const VALIDATE_UIHANDLERS_JS = `
const fs = require('fs');
const path = require('path');

const ENVELOPE_KEYS = new Set(['data', 'action', 'panel', 'type']);

function lint(src) {
    const errors = [];
    const re = /events\\.ui\\.on\\(\\s*["'](ui_event:[^"']+)["']\\s*,\\s*function\\s*\\(\\s*(\\w+)\\s*\\)\\s*\\{/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const eventName = m[1];
        const param = m[2];
        let depth = 1, i = re.lastIndex;
        while (i < src.length && depth > 0) {
            const c = src[i++];
            if (c === '{') depth++;
            else if (c === '}') depth--;
        }
        const body = src.slice(re.lastIndex, i - 1);
        const accessRe = new RegExp('\\\\b' + param + '\\\\.([a-zA-Z_]\\\\w*)', 'g');
        const flagged = new Set();
        let am;
        while ((am = accessRe.exec(body)) !== null) {
            const field = am[1];
            if (!ENVELOPE_KEYS.has(field)) flagged.add(field);
        }
        if (flagged.size > 0) {
            const first = flagged.values().next().value;
            const fields = Array.from(flagged).map(f => param + '.' + f).join(', ');
            errors.push(
                'UI_EVENT envelope misuse for "' + eventName + '": reads ' + fields +
                ' from envelope. Panel data is nested under ' + param + '.data — ' +
                'e.g. var dd = (' + param + ' && ' + param + '.data) || {}; dd.' + first + '. ' +
                'See CREATOR_CONTEXT.md → "Reading a data payload from a panel".'
            );
        }
    }
    return errors;
}

function walk(dir, prefix, visit) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, prefix + entry.name + '/', visit);
        else if (entry.name.endsWith('.ts')) visit(full, prefix + entry.name);
    }
}

const errors = [];
for (const dir of ['systems', 'behaviors', 'scripts']) {
    walk(path.join('project', dir), '', (full, rel) => {
        const src = fs.readFileSync(full, 'utf-8');
        for (const e of lint(src)) errors.push(dir + '/' + rel + ': ' + e);
    });
}
if (errors.length > 0) {
    for (const e of errors) console.error(e);
    process.exit(1);
}
`;

// Unified headless smoke. Stubs every major GameScript surface (entity,
// scene, input, ui, audio, time) so a script's onStart doesn't null-deref
// before we've had a chance to exercise onUpdate. Browser-only error
// fragments (document/window/canvas/WebSocket/etc.) are filtered so
// lighting / network scripts don't produce false positives node-side.
const VALIDATE_HEADLESS_JS = `
const fs = require('fs');
const path = require('path');

class GameScript {
    constructor() {
        this.entity = { id: 0, name: '', active: true, tags: new Set(), transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 }, lookAt() {}, setRotationEuler() {} }, getComponent() { return null; }, playAnimation() {}, setActive() {}, setMaterialColor() {}, addTag() {}, removeTag() {}, getScript() { return null; } };
        this.scene = { events: { game: { on() {}, emit() {} }, ui: { on() {}, emit() {} } }, findEntityByName() { return null; }, findEntitiesByName() { return []; }, findEntitiesByTag() { return []; }, setPosition() {}, setScale() {}, setRotationEuler() {}, setVelocity() {}, destroyEntity() {}, createEntity() { return 0; }, spawnEntity() { return null; }, addComponent() { return null; }, removeComponent() {}, raycast() { return null; }, screenRaycast() { return null; }, screenPointToGround() { return null; }, getAllEntities() { return []; }, setFog() {}, setTimeOfDay() {}, loadScene() {}, saveData() {}, loadData() { return null; }, deleteData() {}, listSaveKeys() { return []; }, getTerrainHeight() { return 0; }, getTerrainNormal() { return { x: 0, y: 1, z: 0 }; }, _fpsYaw: 0, _tpYaw: 0, reloadScene() {} };
        this.input = { isKeyDown() { return false; }, isKeyJustPressed() { return false; }, isKeyPressed() { return false; }, isKeyJustReleased() { return false; }, isKeyReleased() { return false; }, isMouseButtonDown() { return false; }, isMouseButtonJustPressed() { return false; }, isMouseButtonJustReleased() { return false; }, getMousePosition() { return { x: 0, y: 0 }; }, getMouseX() { return 0; }, getMouseY() { return 0; }, getMouseDelta() { return { x: 0, y: 0 }; }, getMouseDeltaX() { return 0; }, getMouseDeltaY() { return 0; }, getScrollDelta() { return { x: 0, y: 0 }; }, getModifiers() { return {}; }, getGamepadAxis() { return 0; }, isGamepadButtonDown() { return false; }, requestPointerLock() {}, exitPointerLock() {}, isPointerLocked() { return false; } };
        this.ui = { createText() { return { text: '', remove() {}, x: 0, y: 0 }; }, createPanel() { return { remove() {} }; }, createButton() { return { remove() {} }; }, createImage() { return { remove() {} }; }, sendState() {} };
        this.audio = { playSound() {}, playMusic() {}, stopMusic() {}, setGroupVolume() {}, getGroupVolume() { return 1; }, preload() {} };
        this.time = { time: 0, deltaTime: 1/60, frameCount: 0 };
    }
    onStart() {} onUpdate() {} onLateUpdate() {} onFixedUpdate() {} onDestroy() {}
}
class Vec3 { constructor(x,y,z) { this.x=x||0; this.y=y||0; this.z=z||0; } }
class Quat { constructor(x,y,z,w) { this.x=x||0; this.y=y||0; this.z=z||0; this.w=w!==undefined?w:1; } }

const errors = [];
const scripts = {};

function loadScripts(dir, prefix) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) loadScripts(full, prefix + entry.name + '/');
        else if (entry.name.endsWith('.ts')) scripts[prefix + entry.name] = fs.readFileSync(full, 'utf-8');
    }
}
loadScripts('project/behaviors', 'behaviors/');
loadScripts('project/systems', 'systems/');
loadScripts('project/scripts', 'scripts/');

function stripForSyntaxCheck(s) {
    return s.replace(/^\\s*export\\s+default\\s+/gm, '').replace(/^\\s*export\\s+/gm, '').replace(/^\\s*import\\s+.*$/gm, '').replace(/\\bconst\\b/g, 'var').replace(/(?:var|let)\\s+(\\w+)\\s*:\\s*[^=\\n]+=/g, 'var $1 =');
}

for (const [key, source] of Object.entries(scripts)) {
    try {
        const clean = stripForSyntaxCheck(source);
        const m = clean.match(/class\\s+(\\w+)/);
        if (!m) continue;
        const fn = new Function('GameScript', 'Vec3', 'Quat', clean + '\\nreturn ' + m[1] + ';');
        const Cls = fn(GameScript, Vec3, Quat);
        const inst = new Cls();
        inst.onStart();
        for (let i = 0; i < 60; i++) {
            inst.time = { time: i/60, deltaTime: 1/60, frameCount: i };
            if (typeof inst.onUpdate === 'function') inst.onUpdate(1/60);
        }
    } catch (e) {
        const msg = e.message || '';
        if (!/document|window|canvas|AudioContext|WebSocket|fetch|pointerLock/i.test(msg)) {
            errors.push(key + ': ' + msg);
        }
    }
}

if (errors.length === 0) {
    console.log('Headless smoke test passed (' + Object.keys(scripts).length + ' scripts).');
} else {
    for (const e of errors) console.error(e);
    process.exit(1);
}
`;
