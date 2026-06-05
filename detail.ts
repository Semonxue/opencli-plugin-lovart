/**
 * `opencli lovart project <id>` — fetch a single Lovart project's details.
 *
 * Hits `canva/project/queryProject` and extracts image/video/group counts from
 * the canvas. Three output modes:
 *
 *   • Default (no flags)  → counts: images, generators, users, videos, groups
 *   --images            → list all artifact image URLs (generator/user/agent)
 *   --canvas            → raw canvasDataV1 object (JSON)
 *   --export-canvas <f> → write tldrawSnapshot to a local .json file
 *
 * Auth: `usertoken` cookie forwarded as `token` header (same as `projects`).
 * videoCount / groupCount require canvasDataV1 (canvas API fallback in progress).
 *
 * Project URL pattern: `https://www.lovart.ai/canvas?projectId=<id>`
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { readLovartProject, parseLovartProjectImages } from './utils.js';

cli({
    site: 'lovart',
    name: 'project',
    access: 'read',
    description:
        'Show a Lovart project: image/video/group counts and URLs.\n' +
        'Usage:\n' +
        '  opencli lovart project <id>                  # summary (images, generators, users, videos)\n' +
        '  opencli lovart project <id> --images         # list all image URLs\n' +
        '  opencli lovart project <id> --canvas         # raw canvasDataV1 JSON\n' +
        '  opencli lovart project <id> --export-canvas f # write tldrawSnapshot to file.json\n' +
        '  opencli lovart project <id> -f json          # output as JSON\n' +
        'Notes:\n' +
        '  - imageCount = all artifact images (generator + user + agent)\n' +
        '  - videoCount = video poster frames (requires canvasDataV1, currently 0)\n' +
        '  - groupCount = tldraw group shapes (requires canvasDataV1, currently 0)',
    domain: 'www.lovart.ai',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        {
            name: 'projectId',
            type: 'string',
            positional: true,
            help: 'The 32-char hex project ID (from opencli lovart projects or the canvas URL).',
        },
        {
            name: 'images',
            default: false,
            type: 'boolean',
            help: 'Include a per-image URL table (shapeId, url, w, h, type).',
        },
        {
            name: 'canvas',
            default: false,
            type: 'boolean',
            help: 'Show the raw canvasDataV1 JSON object instead of image summaries.',
        },
        {
            name: 'exportCanvas',
            default: '',
            type: 'string',
            help: 'Path to write the tldrawSnapshot as a local .json file.',
        },
    ],
    columns: ['projectId', 'projectName', 'projectType', 'imageCount', 'generatorCount', 'userCount', 'videoCount', 'imageUrl'],
    func: async (page: any, kwargs: any) => {
        const projectId = String(kwargs.projectId || '').trim();
        if (!projectId) throw new Error('projectId is required (e.g. 140b5026cfe04d9e9bf24b84ffbe138a)');

        const includeImages = Boolean(kwargs.images);
        const rawCanvas = Boolean(kwargs.canvas);
        const exportPath = String(kwargs.exportCanvas || '').trim();

        const result = await readLovartProject(page, projectId);

        // Count images by type
        const generatorCount = result.images.filter((i) => i.type === 'generator').length;
        const userCount = result.images.filter((i) => i.type === 'user').length;
        const agentCount = result.images.filter((i) => i.type === 'agent').length;
        const videoCount = result.images.filter((i) => i.type === 'video').length;
        // Video and group counts require canvasDataV1 (not yet available via API/localStorage)
        const vCount = videoCount || 0;

        if (rawCanvas) {
            if (!result.canvasDataV1) throw new Error('No canvasDataV1 found — canvas may be empty.');
            const snapshot = result.canvasDataV1.tldrawSnapshot;
            if (exportPath) {
                const fs = await import('fs');
                fs.writeFileSync(exportPath, JSON.stringify(snapshot, null, 2), 'utf-8');
            }
            return [{
                projectId: result.projectId,
                projectName: result.projectName,
                projectType: result.projectType,
                imageCount: result.images.length,
                generatorCount,
                userCount,
                videoCount: vCount,
                imageUrl: JSON.stringify(result.canvasDataV1, null, 2),
            }];
        }

        if (includeImages) {
            // Image rows: URL in imageUrl, counts in the first row, rest empty
            return result.images.map((img, idx) => ({
                projectId: idx === 0 ? result.projectId : '',
                projectName: idx === 0 ? result.projectName : '',
                projectType: idx === 0 ? result.projectType : '',
                imageCount: idx === 0 ? result.images.length : '',
                generatorCount: idx === 0 ? generatorCount : '',
                userCount: idx === 0 ? userCount : '',
                videoCount: idx === 0 ? vCount : '',
                imageUrl: img.url,
            }));
        }

        return [{
            projectId: result.projectId,
            projectName: result.projectName,
            projectType: result.projectType,
            imageCount: result.images.length,
            generatorCount,
            userCount,
            videoCount: vCount,
            imageUrl: '',
        }];
    },
});