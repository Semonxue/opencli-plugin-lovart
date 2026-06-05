/**
 * `opencli lovart project <id>` — fetch a single Lovart project's details.
 *
 * Hits `canva/project/queryProject` and decompresses the SHAKKERDATA canvas blob
 * to extract image/video/group counts and URLs.
 *
 * Flags:
 *   <id>              → one-line summary (name + asset counts)
 *   --images          → AI生成的图 (gen-image shapes from /artifacts/generator/)
 *   --videos          → AI生成的视频 (gen-video shapes, MP4 URLs)
 *   --uploads         → 用户上传 (user-image shapes from /artifacts/user/)
 *   --all             → all of the above combined
 *   --canvas          → raw canvas JSON
 *   --export-canvas f → write tldrawSnapshot to file.json
 *   --dump-page f     → write full page state (debug)
 *
 * Auth: `usertoken` cookie forwarded as `token` header.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { readLovartProject, dumpLovartProjectPage } from './utils.js';

const KIND_EMOJI: Record<string, string> = {
    'gen-image':  '🖼️',
    'gen-video':  '🎬',
    'user-image': '📷',
};

cli({
    site: 'lovart',
    name: 'project',
    access: 'read',
    description:
        'Show a Lovart project: asset counts and URLs.\n' +
        'Usage:\n' +
        '  opencli lovart project <id>              # summary\n' +
        '  opencli lovart project <id> --images     # AI生成的图\n' +
        '  opencli lovart project <id> --videos     # AI生成的视频\n' +
        '  opencli lovart project <id> --uploads   # 用户上传的图\n' +
        '  opencli lovart project <id> --all        # all three above\n' +
        '  opencli lovart project <id> --all --limit 20   # 前20条\n' +
        '  opencli lovart project <id> --canvas    # raw canvas JSON\n' +
        '  opencli lovart project <id> --export-canvas f  # save tldrawSnapshot\n' +
        '  opencli lovart project <id> --dump-page f      # full page debug dump',
    domain: 'www.lovart.ai',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        {
            name: 'projectId',
            type: 'string',
            positional: true,
            help: '32-char hex project ID (from opencli lovart projects or canvas URL).',
        },
        {
            name: 'images',
            default: false,
            type: 'boolean',
            help: 'List AI生成的图 (c-image from /artifacts/generator/).',
        },
        {
            name: 'videos',
            default: false,
            type: 'boolean',
            help: 'List AI生成的视频 (c-video shapes, MP4 URLs).',
        },
        {
            name: 'uploads',
            default: false,
            type: 'boolean',
            help: 'List 用户上传的图 (c-image from /artifacts/user/).',
        },
        {
            name: 'all',
            default: false,
            type: 'boolean',
            help: 'List all assets: images + videos + uploads.',
        },
        {
            name: 'canvas',
            default: false,
            type: 'boolean',
            help: 'Show raw canvasDataV1 JSON.',
        },
        {
            name: 'exportCanvas',
            default: '',
            type: 'string',
            help: 'Path to write the full canvas JSON (canvasDataV1) to a local .json file.',
        },
        {
            name: 'limit',
            default: 0,
            type: 'int',
            help: 'Max asset rows to list (0 = unlimited). Use with --images/--videos/--uploads/--all.',
        },
        {
            name: 'dumpPage',
            default: '',
            type: 'string',
            help: 'Path to dump all raw page state for debugging.',
        },
    ],
    columns: ['type', 'size', 'url'],
    func: async (page: any, kwargs: any) => {
        const projectId = String(kwargs.projectId || '').trim();
        if (!projectId) throw new Error('projectId is required (e.g. 140b5026cfe04d9e9bf24b84ffbe138a)');

        const showImages = Boolean(kwargs.images);
        const showVideos = Boolean(kwargs.videos);
        const showUploads = Boolean(kwargs.uploads);
        const showAll = Boolean(kwargs.all);
        const showCanvas = Boolean(kwargs.canvas);
        const exportPath = String(kwargs.exportCanvas || '').trim();
        const dumpPath = String(kwargs.dumpPage || '').trim();
        const limit = Number(kwargs.limit) || 0;

        // --dump-page: capture everything and exit
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
        if (gi > 0) parts.push(`${gi}张图`);
        if (gv > 0) parts.push(`${gv}个视频`);
        if (ui > 0) parts.push(`${ui}上传`);
        if (gc > 0) parts.push(`${gc}分组`);
        const assetSummary = parts.join(' · ') || '空项目';

        // --canvas: raw JSON output
        if (showCanvas) {
            if (!result.canvasDataV1) throw new Error('Canvas data is empty.');
            if (exportPath) {
                const fs = await import('fs');
                fs.writeFileSync(exportPath, JSON.stringify(result.canvasDataV1, null, 2), 'utf-8');
            }
            return [{
                type: `📦 ${result.projectName} · ${assetSummary}`,
                size: exportPath ? `已保存 → ${exportPath}` : '',
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
                size: 'canvas已保存',
                url: exportPath,
            }];
        }

        const showAny = showImages || showVideos || showUploads || showAll;

        // Build asset rows
        const rows: Array<{ type: string; size: string; url: string }> = [];

        // Summary row first (always shown)
        const summary: Array<{ type: string; size: string; url: string }> = [{
            type: `📦 ${result.projectName}`,
            size: assetSummary,
            url: '',
        }];

        const assetRows: Array<{ type: string; size: string; url: string }> = [];

        if (showAll || showImages) {
            for (const a of result.genImages) {
                assetRows.push({ type: KIND_EMOJI[a.kind] ?? '🖼️', size: fmtSize(a.w, a.h), url: a.url });
            }
        }

        if (showAll || showVideos) {
            for (const a of result.genVideos) {
                assetRows.push({ type: KIND_EMOJI[a.kind] ?? '🎬', size: fmtSize(a.w, a.h), url: a.url });
            }
        }

        if (showAll || showUploads) {
            for (const a of result.userImages) {
                assetRows.push({ type: KIND_EMOJI[a.kind] ?? '📷', size: fmtSize(a.w, a.h), url: a.url });
            }
        }

        // Apply limit if specified
        const finalRows = limit > 0 ? [...summary, ...assetRows.slice(0, limit)] : [...summary, ...assetRows];

        // If no asset flags, just return the summary row
        return showAny ? finalRows : summary;
    },
});

function fmtSize(w: number, h: number): string {
    if (!w || !h) return '';
    return `${Math.round(w)}×${Math.round(h)}`;
}
