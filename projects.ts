/**
 * `opencli lovart projects` — list the user's projects on Lovart.
 *
 * Hits Lovart's `canva/lovartProjectList` endpoint, paginated, and
 * returns one row per project. Each row carries:
 *   - `id`       — 32-char projectId used in the canvas URL
 *   - `url`      — fully-qualified link to open the project in a browser
 *   - `name`     — project title
 *   - `picCount` — number of generated images inside the project
 *   - `isFavorite` — whether the user has starred the project
 *   - `projectType` — Lovart-internal type id
 *   - `updated`  — last-updated time, formatted `MMM D, YYYY`
 *
 * Default order is `desc` (newest first) — the natural way users scan
 * a project list. Pass `--order asc` to flip.
 *
 * The `usertoken` cookie is the auth; we forward it as the `token`
 * header the Lovart studio frontend uses. No public API.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { readLovartProjects } from './lib/utils.js';

cli({
    site: 'lovart',
    name: 'projects',
    access: 'read',
    description: 'List the current Lovart projects (id, url, name, cover, picCount, isFavorite, projectType, updated).',
    example: 'opencli lovart projects --limit 10 --order desc -f json',
    domain: 'www.lovart.ai',
    strategy: Strategy.COOKIE,
    browser: true,
    // Skip the pre-nav to the homepage — go straight to /projects and let
    // Lovart's own locale routing redirect to /zh/projects (or /projects).
    navigateBefore: 'https://www.lovart.ai/projects',
    args: [
        { name: 'limit', type: 'int', default: 5, help: 'Max projects to return (default: 5)' },
        { name: 'order', default: 'desc', choices: ['desc', 'asc'], help: 'Sort by updated time: desc (newest first) or asc (oldest first). Default: desc.' },
    ],
    columns: ['id', 'name', 'updated', 'picCount', 'isFavorite', 'projectType', 'url'],
    func: async (page: any, kwargs: any) => {
        const limit = Number(kwargs.limit);
        const order = String(kwargs.order ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
        const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 5;
        // API returns pages in desc order by default — fetch just what we
        // need (capped at LIST_PAGE_SIZE=30 per request) and reverse for asc.
        const rows = await readLovartProjects(page, { limit: safeLimit });
        return order === 'asc' ? rows.reverse() : rows;
    },
});

/**
 * Sort rows by their `updated` string. The API hands back dates in
 * `MMM D, YYYY` (en-US short) — `Date.parse` handles that directly.
 * Rows with an unparseable date sink to the bottom regardless of
 * order so the user never loses data.
 */
export function sortProjectsByUpdated(rows: any[], order: 'asc' | 'desc'): any[] {
    const sign = order === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
        const ta = Date.parse(a?.updated || '');
        const tb = Date.parse(b?.updated || '');
        const va = Number.isFinite(ta) ? ta : Number.NEGATIVE_INFINITY;
        const vb = Number.isFinite(tb) ? tb : Number.NEGATIVE_INFINITY;
        if (va === vb) return 0;
        return va < vb ? -sign : sign;
    });
}
