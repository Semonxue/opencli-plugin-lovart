/**
 * `opencli lovart project <id>` — fetch a single Lovart project's details.
 *
 * Hits `canva/project/queryProject` and decompresses the SHAKKERDATA canvas blob
 * to extract image/video/group counts and URLs.
 *
 * Flags:
 *   <id>              → list all assets (default)
 *   --type <kind>     → filter: image | video | upload | all
 *   --canvas          → raw canvas JSON
 *   --export-canvas f → write full canvas JSON to file
 *   --export-page f   → write full page state (debug)
 *
 * Auth: `usertoken` cookie forwarded as `token` header.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { readLovartProject, dumpLovartProjectPage, resolveListKind, parseCanvasTree, LIST_KIND_TREE, CanvasTreeRow } from './lib/utils.js';

const KIND_EMOJI: Record<string, string> = {
    'gen-image':  '🖼️',
    'gen-video':  '🎬',
    'user-image': '📷',
};

cli({
    site: 'lovart',
    name: 'project',
    access: 'read',
    description: 'Show a Lovart project: asset counts and URLs. Use --help to see examples.',
    example: 'opencli lovart project <id> --list all --limit 5 -f yaml',
    domain: 'www.lovart.ai',
    strategy: Strategy.COOKIE,
    browser: true,
    // Pre-nav to the homepage so document.cookie can read the domain-scoped
    // `usertoken` — the queryProject API is then called directly without any
    // extra page.goto.
    navigateBefore: 'https://www.lovart.ai',
    args: [
        {
            name: 'projectId',
            type: 'string',
            positional: true,
            help: '32-char hex project ID (from opencli lovart projects or canvas URL).',
        },
        {
            name: 'list',
            default: '',
            type: 'string',
            help: 'List assets: all, image, video, upload, all-tree. Omit for summary only.',
        },
        {
            name: 'canvas',
            default: false,
            help: 'Show raw canvas JSON. Pass true to enable: --canvas true',
        },
        {
            name: 'export-canvas',
            default: '',
            type: 'string',
            help: 'Path to write the full canvas JSON (canvasDataV1) to a local .json file.',
        },
        {
            name: 'limit',
            default: 10,
            type: 'int',
            help: 'Max asset rows to list.',
        },
        {
            name: 'export-page',
            default: '',
            type: 'string',
            help: 'Path to dump all raw page state for debugging.',
        },
    ],
    columns: ['id', 'parent', 'type', 'name', 'source', 'size', 'duration', 'task', 'url'],
    func: async (page: any, kwargs: any) => {
        const projectId = String(kwargs.projectId || '').trim();
        if (!projectId) throw new Error('projectId is required (e.g. a1b2c3d4e5f6789012345678abcdef01)');

        const listKindRaw = String(kwargs.list || '').toLowerCase();
        const validKinds = new Set(['all', 'image', 'video', 'upload', LIST_KIND_TREE]);
        // Accept common plurals so `--list images` works the way most users
        // instinctively type it. Unknown values fall back to "summary only"
        // rather than blowing up — the choice validator is intentionally
        // absent so empty/default doesn't trip a hard error.
        const aliases: Record<string, string> = {
            images: 'image',
            videos: 'video',
            uploads: 'upload',
            trees: LIST_KIND_TREE,
            tree: LIST_KIND_TREE,
        };
        const normalized = aliases[listKindRaw] ?? listKindRaw;
        const listKind = validKinds.has(normalized) ? normalized : '';
        const showCanvas = kwargs.canvas === true || kwargs.canvas === 'true';
        const exportPath = String(kwargs['export-canvas'] || '').trim();
        const dumpArg = kwargs['export-page'];
        const dumpPath = (typeof dumpArg === 'string' && dumpArg.trim()) ? dumpArg.trim() : '';
        const limit = Number(kwargs.limit) || 0;

        // --dump-page: capture everything and exit (only if path is provided)
        if (dumpPath) {
            await dumpLovartProjectPage(page, projectId, dumpPath);
            return [{ type: 'debug', size: '', url: `Dumped → ${dumpPath}` }];
        }

        const result = await readLovartProject(page, projectId);

        // Build asset summary line
        const gi = result.genImages.length;
        const gv = result.genVideos.length;
        const ui = result.userImages.length;
        const gc = result.groupCount;
        const parts: string[] = [];
        if (gi > 0) parts.push(`${gi} img`);
        if (gv > 0) parts.push(`${gv} vid`);
        if (ui > 0) parts.push(`${ui} upload`);
        if (gc > 0) parts.push(`${gc} group`);
        const assetSummary = parts.join(' · ') || 'empty';

        // Summary row first (always shown)
        const summaryRow = (): { type: string; size: string; info: string; url: string } => ({
            type: `📦 ${result.projectName}`,
            size: assetSummary,
            info: `${result.projectId} · type=${result.projectType}`,
            url: result.url,
        });

        // --list all-tree: structured tree (containers + their children + top-level)
        if (listKind === LIST_KIND_TREE) {
            const tree = parseCanvasTree(
                result.canvasDataV1,
                result.projectName,
                result.projectId,
                result.projectType,
                result.url,
            );
            // Update summary with real counts
            const c = tree.counts;
            const summaryName = `${result.projectName} · ${c.aiImages} ai-img · ${c.aiVideos} ai-vid · ${c.uploads} upload · ${c.containers} container`;
            tree.summary.name = summaryName;
            tree.summary.info = `${result.projectId} · type=${result.projectType}`;

            // For md/table: we can't easily inject ASCII tree characters
            // via opencli's column renderer. We CAN, however, prefix the
            // `type` column with a depth-based indent so the tree reads
            // hierarchically. Compute depth = number of parent hops.
            const byId: Record<string, CanvasTreeRow> = {};
            for (const r of tree.rows) byId[r.id] = r;
            const depthOf = (id: string): number => {
                let d = 0;
                let cur = byId[id];
                while (cur && cur.parent && cur.parent !== id) {
                    d++;
                    cur = byId[cur.parent];
                }
                return d;
            };

            // Limit handling: applies to material rows only, not to
            // containers or summary — we never want to lop off the
            // container header and leave its children orphaned.
            let finalRows = tree.rows;
            if (limit > 0) {
                const summaryRow = tree.rows[0];
                const containerRows = tree.rows.filter(r => r.type === 'frame' || r.type === 'group');
                const materialRows = tree.rows.filter(r => r.type === 'c-image' || r.type === 'c-video');
                const truncated = materialRows.slice(0, limit);
                finalRows = [summaryRow, ...containerRows, ...truncated];
            }

            // Render: each row maps to a column-record. Every field is a
            // direct projection of the row data — no emoji decoration, no
            // synthetic indent characters, no inline task markers. The
            // `type` column is a raw enum so it round-trips back to the
            // canvas source; depth is recoverable from the `parent` field
            // via `byId` lookup. Visual indentation (if desired) is a
            // presentation-layer concern, not a row field.
            return finalRows.map((r) => ({
                id: r.id,
                parent: r.parent,
                type: r.type,
                name: r.name,
                source: r.source,
                size: r.size,
                duration: r.duration,
                task: r.task,
                url: r.url,
            }));
        }

        // --canvas: raw JSON output
        if (showCanvas) {
            if (!result.canvasDataV1) throw new Error('Canvas data is empty.');
            if (exportPath) {
                const fs = await import('fs');
                fs.writeFileSync(exportPath, JSON.stringify(result.canvasDataV1, null, 2), 'utf-8');
            }
            return [{
                type: `📦 ${result.projectName} · ${assetSummary}`,
                size: exportPath ? `saved → ${exportPath}` : '',
                info: `${result.projectId} · type=${result.projectType}`,
                url: JSON.stringify(result.canvasDataV1, null, 2),
            }];
        }

        // --export-canvas: save and return summary (no --canvas)
        if (exportPath) {
            if (!result.canvasDataV1) throw new Error('Canvas data is empty.');
            const fs = await import('fs');
            fs.writeFileSync(exportPath, JSON.stringify(result.canvasDataV1, null, 2), 'utf-8');
            return [{
                type: `📦 ${result.projectName} · ${assetSummary}`,
                size: 'canvas saved',
                info: `${result.projectId} · type=${result.projectType}`,
                url: exportPath,
            }];
        }

        // --list <kind>: empty string means "summary only" (no asset rows)
        const showList = listKind === 'all' || listKind === 'image' || listKind === 'video' || listKind === 'upload';
        const showAll = listKind === 'all';
        const showImages = showList && (showAll || listKind === 'image');
        const showVideos = showList && (showAll || listKind === 'video');
        const showUploads = showList && (showAll || listKind === 'upload');

        const summary: Array<{ type: string; size: string; info: string; url: string }> = [summaryRow()];

        if (!showList) return summary;

        const assetRows: Array<{ type: string; size: string; info: string; url: string }> = [];

        if (showImages) {
            for (const a of result.genImages) {
                assetRows.push({ type: KIND_EMOJI[a.kind] ?? '🖼️', size: fmtSize(a.w, a.h), info: a.kind, url: a.url });
            }
        }

        if (showVideos) {
            for (const a of result.genVideos) {
                assetRows.push({ type: KIND_EMOJI[a.kind] ?? '🎬', size: fmtSize(a.w, a.h), info: a.kind, url: a.url });
            }
        }

        if (showUploads) {
            for (const a of result.userImages) {
                assetRows.push({ type: KIND_EMOJI[a.kind] ?? '📷', size: fmtSize(a.w, a.h), info: a.kind, url: a.url });
            }
        }

        // Apply limit if specified
        return limit > 0 ? [...summary, ...assetRows.slice(0, limit)] : [...summary, ...assetRows];
    },
});

function fmtSize(w: number, h: number): string {
    if (!w || !h) return '';
    return `${Math.round(w)}×${Math.round(h)}`;
}
