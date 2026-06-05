/**
 * `opencli lovart project <id>` — fetch a single Lovart project's details.
 *
 * Hits `canva/project/queryProject` and parses the canvasDataV1 JSON blob
 * inside `data.canvas`. Supports three output modes:
 *
 *   • Default (no flags)  → basic metadata + image counts
 *   --images            → per-image URL table
 *   --canvas            → raw canvasDataV1 object
 *   --export-canvas <f> → write tldrawSnapshot to a local .json file
 *
 * Auth: `usertoken` cookie forwarded as `token` header (same as `projects`).
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
        'Show a Lovart project: metadata, image counts, and image URL table. ' +
        'Usage: opencli lovart project <id> [--images] [--canvas] [--export-canvas <file>]',
    domain: 'www.lovart.ai',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        {
            name: 'projectId',
            type: 'string',
            help: 'The 32-char hex project ID (from project list or canvas URL).',
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
    columns: ['projectId', 'projectName', 'projectType', 'version', 'isValidProject', 'isTitleChanged', 'imageCount', 'generatorCount', 'userCount'],
    func: async (page: any, kwargs: any) => {
        const projectId = String(kwargs.projectId || '').trim();
        if (!projectId) throw new Error('projectId is required (e.g. 140b5026cfe04d9e9bf24b84ffbe138a)');

        const includeImages = Boolean(kwargs.images);
        const rawCanvas = Boolean(kwargs.canvas);
        const exportPath = String(kwargs.exportCanvas || '').trim();

        const result = await readLovartProject(page, projectId);

        // Always return the metadata row
        const meta = {
            projectId: result.projectId,
            projectName: result.projectName,
            projectType: result.projectType,
            version: result.version,
            isValidProject: result.isValidProject,
            isTitleChanged: result.isTitleChanged,
            imageCount: result.images.length,
            generatorCount: result.images.filter((i) => i.type === 'generator').length,
            userCount: result.images.filter((i) => i.type === 'user').length,
        };

        if (exportPath) {
            const snapshot = result.canvasDataV1?.tldrawSnapshot;
            if (!snapshot) throw new Error('No tldrawSnapshot found — canvas may be empty.');
            const fs = await import('fs');
            fs.writeFileSync(exportPath, JSON.stringify(snapshot, null, 2), 'utf-8');
            meta['exportFile'] = exportPath;
        }

        if (rawCanvas) {
            if (!result.canvasDataV1) throw new Error('No canvasDataV1 found — canvas may be empty.');
            return [{
                ...meta,
                canvasDataV1: JSON.stringify(result.canvasDataV1, null, 2),
            }];
        }

        if (includeImages) {
            return result.images.map((img) => ({
                shapeId: img.shapeId,
                imageUrl: img.url,
                width: img.w,
                height: img.h,
                imageType: img.type,
                projectName: '',
                projectType: '',
                projectId: '',
                version: '',
                isValidProject: '',
                isTitleChanged: '',
                imageCount: '',
                generatorCount: '',
                userCount: '',
            }));
        }

        return [meta];
    },
});