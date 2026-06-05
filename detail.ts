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
        'Show a Lovart project: asset counts and URLs. Use --help to see examples.',
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
            name: 'type',
            default: 'all',
            type: 'string',
            choices: ['all', 'image', 'video', 'upload'],
            help: 'Asset type to list. Default: all (lists everything).',
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
    columns: ['type', 'size', 'url'],
    func: async (page: any, kwargs: any) => {
        const projectId = String(kwargs.projectId || '').trim();
        if (!projectId) throw new Error('projectId is required (e.g. 140b5026cfe04d9e9bf24b84ffbe138a)');

        const assetType = String(kwargs.type || 'all').toLowerCase();
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
                url: exportPath,
            }];
        }

        const showAll = assetType === 'all';
        const showImages = showAll || assetType === 'image';
        const showVideos = showAll || assetType === 'video';
        const showUploads = showAll || assetType === 'upload';

        // Build asset rows
        const rows: Array<{ type: string; size: string; url: string }> = [];

        // Summary row first (always shown)
        const summary: Array<{ type: string; size: string; url: string }> = [{
            type: `📦 ${result.projectName}`,
            size: assetSummary,
            url: '',
        }];

        const assetRows: Array<{ type: string; size: string; url: string }> = [];

        if (showImages) {
            for (const a of result.genImages) {
                assetRows.push({ type: KIND_EMOJI[a.kind] ?? '🖼️', size: fmtSize(a.w, a.h), url: a.url });
            }
        }

        if (showVideos) {
            for (const a of result.genVideos) {
                assetRows.push({ type: KIND_EMOJI[a.kind] ?? '🎬', size: fmtSize(a.w, a.h), url: a.url });
            }
        }

        if (showUploads) {
            for (const a of result.userImages) {
                assetRows.push({ type: KIND_EMOJI[a.kind] ?? '📷', size: fmtSize(a.w, a.h), url: a.url });
            }
        }

        // Apply limit if specified
        const finalRows = limit > 0 ? [...summary, ...assetRows.slice(0, limit)] : [...summary, ...assetRows];

        // When --type filters, drop the summary row so the output is just the filtered assets.
        return showAll ? finalRows : assetRows.slice(0, limit > 0 ? limit : assetRows.length);
    },
});

function fmtSize(w: number, h: number): string {
    if (!w || !h) return '';
    return `${Math.round(w)}×${Math.round(h)}`;
}
