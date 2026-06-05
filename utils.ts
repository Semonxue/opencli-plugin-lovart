/**
 * Shared helpers for the Lovart plugin.
 *
 * Strategy is `UI` — Lovart is a React SPA, login state lives in cookies,
 * and project / account data is rendered in DOM. No public API.
 *
 * Selectors of note (verified 2026-06):
 *   - Avatar trigger in the top nav: [data-testid="avatar-trigger"]
 *   - User popover that opens from the trigger: [data-testid="avatar-popover-content"]
 *   - Projects grid: [role=grid] containing [role=gridcell] cards
 *   - Individual card text format: "项目名\n更新于 MMM D, YYYY"
 *
 * Project canvas URLs are JS-routed (no static <a href>), so reaching the
 * canvas requires an extra click — we don't return project ids from
 * `projects` here; agents can grab the name and feed it to follow-up
 * commands once `canvas <id|search>` lands.
 */
import { AuthRequiredError } from '@jackwener/opencli/errors';

export const LOVART_DOMAIN = 'www.lovart.ai';
export const LOVART_HOMEPAGE = 'https://www.lovart.ai/zh/home';
export const LOVART_PROJECTS = 'https://www.lovart.ai/zh/projects';

/**
 * Bridge wraps primitive `page.evaluate` returns as `{ session, data: <value> }`
 * so unwrap before inspecting the result.
 */
export function unwrapEvaluateResult<T = unknown>(value: unknown): T {
    if (value && typeof value === 'object' && 'session' in value && 'data' in value) {
        return (value as { data: T }).data;
    }
    return value as T;
}

const POPOVER_TIMEOUT_MS = 5000;

export interface LovartMe {
    name: string;
    email: string;
    plan: string;
    credits: string;
    profile_url: string;
    signout_visible: boolean;
}

export interface LovartProject {
    name: string;
    updated: string;
    id: string;
    url: string;
    picCount: number;
    isFavorite: boolean;
    projectType: number;
}

/**
 * Open the avatar popover and return a single identity row.
 *
 * Throws AuthRequiredError when the avatar trigger is missing (not logged in)
 * or the popover never appears.
 */
export async function readLovartMe(page: any): Promise<LovartMe[]> {
    await page.goto(LOVART_HOMEPAGE);
    await page.wait({ selector: '[data-testid="primaryColumn"], body', timeoutMs: 8000 });

    const trigger = unwrapEvaluateResult<boolean>(await page.evaluate(
        `(() => !!document.querySelector('[data-testid="avatar-trigger"]'))()`
    ));
    if (!trigger) {
        throw new AuthRequiredError(LOVART_DOMAIN, 'Lovart avatar trigger not found. Are you logged in to lovart.ai?');
    }

    await page.click('[data-testid="avatar-trigger"]');

    let raw: string[] | null = null;
    for (let i = 0; i < POPOVER_TIMEOUT_MS / 250; i++) {
        raw = unwrapEvaluateResult<string[] | null>(await page.evaluate(
            `(() => {
                const pop = document.querySelector('[data-testid="avatar-popover-content"]');
                if (!pop) return null;
                const lines = (pop.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
                return lines;
            })()`
        ));
        if (Array.isArray(raw) && raw.length) break;
        await page.wait(0.25);
    }

    if (!Array.isArray(raw) || raw.length === 0) {
        throw new AuthRequiredError(LOVART_DOMAIN, 'Lovart avatar popover did not open. Are you logged in?');
    }

    return [parseMeRows(raw)];
}

/**
 * Parse the popover innerText into a single identity row.
 *
 * The popover layout (verified 2026-06) is roughly:
 *   0: nickname
 *   1: email
 *   2: plan name (e.g. "Ultimate", "Free")
 *   3: credits (numeric string, e.g. "15160")
 *   4: 查看我的权益   (link)
 *   5: 创建团队       (link, optional)
 *   6: 账户管理       (link)
 *   7: 使用指南       (link)
 *   8: 联系我们       (link)
 *   9: locale label   (e.g. "简体中文")
 *  10: footer logo
 *  11: 退出登录       (sign-out, optional)
 */
export function parseMeRows(lines: string[]): LovartMe {
    if (!Array.isArray(lines) || !lines.length) {
        throw new AuthRequiredError(LOVART_DOMAIN, 'Lovart popover returned no content.');
    }
    const name = lines[0] || '';
    const email = (lines[1] || '').includes('@') ? lines[1] : '';
    let plan = '';
    let credits = '';
    for (let i = 0; i < lines.length; i++) {
        if (/^\d+$/.test(lines[i])) {
            credits = lines[i];
            for (let j = 0; j < i; j++) {
                if (lines[j] && lines[j] !== name && lines[j] !== email) {
                    plan = lines[j];
                    break;
                }
            }
            break;
        }
    }
    return {
        name,
        email,
        plan,
        credits,
        profile_url: `${LOVART_DOMAIN}/zh/profile`,
        signout_visible: lines.includes('退出登录'),
    };
}

/**
 * Fetch every Lovart project via the canva API. Walks the
 * `hasMore` cursor in 30-row pages so we don't depend on the grid
 * being painted in the DOM. The `usertoken` cookie is the auth —
 * the adapter rides it via the JWT `token` header the studio
 * frontend uses.
 *
 * Project URL pattern: `https://www.lovart.ai/canvas?projectId=<id>`
 * (32-char hex, same shape as the link we already saw on click).
 */
export async function readLovartProjects(page: any, { limit = 200 }: { limit?: number } = {}): Promise<LovartProject[]> {
    await page.goto(LOVART_PROJECTS);
    await page.wait({ selector: 'body', timeoutMs: 8000 });

    const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 200;
    const rows = await fetchAllProjects(page, safeLimit);
    return rows;
}

interface LovartListItem {
    projectId: string;
    projectName: string;
    projectCoverList: string[];
    picCount: number;
    isFavorite: number;
    projectType: number;
    updateTime: number; // ms epoch
    createTime: number | null;
}

const LIST_PAGE_SIZE = 30;
const LIST_BODY = JSON.stringify({ page: 1, pageSize: LIST_PAGE_SIZE });

async function fetchAllProjects(page: any, limit: number): Promise<LovartProject[]> {
    const collected: LovartProject[] = [];
    let pageNum = 1;
    // Cap inner pages to avoid loops if the server misbehaves.
    while (collected.length < limit && pageNum < 50) {
        const payload = JSON.stringify({ page: pageNum, pageSize: LIST_PAGE_SIZE });
        const result = unwrapEvaluateResult<{
            ok: boolean;
            items?: LovartListItem[];
            total?: number;
            hasMore?: boolean;
            error?: string;
            status?: number;
        }>(await page.evaluate(`
            (async () => {
                const tok = (document.cookie.match(/usertoken=([^;]+)/) || [])[1] || '';
                if (!tok) return { ok: false, error: 'usertoken cookie missing' };
                let resp;
                try {
                    resp = await fetch('/api/canva/project/lovartProjectList?timestamp=' + Date.now(), {
                        method: 'POST',
                        headers: { 'token': tok, 'x-language': 'zh', 'Content-Type': 'application/json' },
                        body: ${JSON.stringify(payload)},
                        credentials: 'include',
                    });
                } catch (e) {
                    return { ok: false, error: 'fetch failed: ' + String(e && e.message || e) };
                }
                if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status, status: resp.status };
                let body;
                try { body = await resp.json(); } catch (e) { return { ok: false, error: 'malformed JSON' }; }
                if (body?.code !== 0 && body?.code !== '0') {
                    return { ok: false, error: 'API code ' + body?.code + ' ' + (body?.msg || '') };
                }
                return {
                    ok: true,
                    items: Array.isArray(body?.data?.data) ? body.data.data : [],
                    total: body?.data?.total || 0,
                    hasMore: Boolean(body?.data?.hasMore),
                };
            })()
        `));

        if (!result || !result.ok) {
            throw new AuthRequiredError(LOVART_DOMAIN, result?.error || 'Lovart projects API failed.');
        }
        const items = Array.isArray(result.items) ? result.items : [];
        for (const it of items) {
            if (!it?.projectId || !it?.projectName) continue;
            collected.push(mapListItem(it));
            if (collected.length >= limit) break;
        }
        if (!result.hasMore || items.length === 0) break;
        pageNum++;
    }
    return collected;
}

function mapListItem(it: LovartListItem): LovartProject {
    return {
        id: it.projectId,
        name: it.projectName,
        url: `https://www.lovart.ai/canvas?projectId=${it.projectId}`,
        picCount: it.picCount || 0,
        isFavorite: Boolean(it.isFavorite),
        projectType: it.projectType || 0,
        updated: formatDate(it.updateTime),
    };
}

function formatDate(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const d = new Date(ms);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// ---------------------------------------------------------------------------
// Project detail (queryProject)
// ---------------------------------------------------------------------------

export interface LovartProjectImage {
    shapeId: string;
    url: string;
    w: number;
    h: number;
    /** 'generator' = AI-generated, 'user' = uploaded, 'agent' = avatar/UI */
    type: 'generator' | 'user' | 'agent';
}

export interface LovartProjectDetail {
    projectId: string;
    projectName: string;
    projectType: number;
    version: string;
    isValidProject: boolean;
    isTitleChanged: boolean;
    isNewProject: boolean;
    /** canvasDataV1 if the canvas was non-empty, null otherwise */
    canvasDataV1: LovartCanvasDataV1 | null;
    images: LovartProjectImage[];
}

export interface LovartCanvasDataV1 {
    tldrawSnapshot?: TldrawSnapshot;
    [key: string]: unknown;
}

export interface TldrawSnapshot {
    document: TldrawDocument;
    store?: unknown;
    session?: TldrawSession;
}

export interface TldrawDocument {
    records: Record<string, TldrawShape>;
    schema?: unknown;
}

export interface TldrawSession {
    pageStates: TldrawPageState[];
}

export interface TldrawPageState {
    id: string;
    camera?: { x: number; y: number; z: number };
    editingId?: string | null;
}

export interface TldrawShape {
    id: string;
    type: string;
    props?: {
        url?: string;
        coverUrl?: string;
        w?: number;
        h?: number;
        [key: string]: unknown;
    };
    parentId?: string;
}

/**
 * Call `canva/project/queryProject` and parse the canvasDataV1 JSON blob.
 *
 * Auth: `usertoken` cookie forwarded as `token` header (same as `projects`).
 * The API retries once on 401 because Lovart sometimes sends a stale cookie
 * that gets refreshed by the first 401.
 */
export async function readLovartProject(
    page: any,
    projectId: string,
): Promise<LovartProjectDetail> {
    // Navigate to the canvas page — Lovart's queryProject API only returns
    // canvas data when the session is on the canvas route (set-cookie + session state).
    const canvasUrl = `https://www.lovart.ai/canvas?projectId=${projectId}`;
    await page.goto(canvasUrl);
    // Wait for the canvas to load by checking for tldraw container
    await page.wait({ selector: '[data-testid="avatar-trigger"]', timeoutMs: 8000 });
    // Extra wait for the studio to hydrate canvas data
    await page.wait(2000);

    const result = unwrapEvaluateResult<{
        ok: boolean;
        data: {
            canvas: string | null;
            projectId: string;
            projectName: string;
            projectType: number;
            version: string;
            userId: string;
            validProjectId: string;
        };
        error?: string;
    }>(await page.evaluate(
        `
        (async () => {
            const tok = (document.cookie.match(/usertoken=([^;]+)/) || [])[1] || '';
            if (!tok) return { ok: false, error: 'usertoken cookie missing' };

            // Retry-once pattern mirrors what the studio frontend does (code 401).
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const resp = await fetch('/api/canva/project/queryProject', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'token': tok,
                            'x-language': 'zh',
                        },
                        body: JSON.stringify({ projectId: ${JSON.stringify(projectId)} }),
                        credentials: 'include',
                    });
                    const body = await resp.json();
                    if (body?.code === 0 || body?.code === '0') {
                        return { ok: true, data: body.data };
                    }
                    if (body?.code === 401 && attempt === 0) continue; // retry once
                    return { ok: false, error: 'API code ' + body?.code + ' ' + (body?.msg || ''), data: body?.data };
                } catch (e) {
                    return { ok: false, error: 'fetch failed: ' + String(e && e.message || e) };
                }
            }
        })()
    `,
    ));

    if (!result || !result.ok) {
        throw new AuthRequiredError(
            LOVART_DOMAIN,
            result?.error || 'Lovart queryProject API failed.',
        );
    }

    const d = result.data;
    // canvas is the serialized canvasDataV1 string (confirmed from live API response)
    const raw = d.canvas ?? '';

    let canvasDataV1: LovartCanvasDataV1 | null = null;
    if (raw) {
        try {
            canvasDataV1 = JSON.parse(raw) as LovartCanvasDataV1;
        } catch {
            // Non-fatal: return null canvas, empty images
        }
    }

    const images = canvasDataV1 ? parseLovartProjectImages(canvasDataV1) : [];

    return {
        projectId: d.projectId || projectId,
        projectName: d.projectName ?? '',
        projectType: d.projectType ?? 3,
        version: d.version ?? '',
        // isValidProject / isTitleChanged are not in the queryProject data payload;
        // the frontend derives them from session state not available here.
        isValidProject: false,
        isTitleChanged: false,
        isNewProject: false,
        canvasDataV1,
        images,
    };
}

/**
 * Extract image shapes from a canvasDataV1 tldrawSnapshot.
 *
 * Shape types confirmed in the bundle (verified 2026-06):
 *   "c-image"  → props.url          (AI-generated or user-uploaded image)
 *   "c-video"  → props.coverUrl    (video poster frame)
 *
 * Type is inferred by the URL path:
 *   /artifacts/generator/  → 'generator'
 *   /artifacts/user/       → 'user'
 *   /artifacts/agent/       → 'agent'
 *   otherwise             → 'unknown' (not emitted in this impl)
 */
export function parseLovartProjectImages(canvasDataV1: LovartCanvasDataV1): LovartProjectImage[] {
    const snapshot = canvasDataV1?.tldrawSnapshot;
    if (!snapshot) return [];

    const records = (snapshot as TldrawSnapshot).document?.records;
    if (!records || typeof records !== 'object') return [];

    const images: LovartProjectImage[] = [];

    for (const [shapeId, shape] of Object.entries(records)) {
        if (!shape || typeof shape !== 'object') continue;
        const s = shape as TldrawShape;
        if (s.type === 'c-image' || s.type === 'c-video') {
            const url = s.type === 'c-image'
                ? (s.props?.url ?? '')
                : (s.props?.coverUrl ?? '');
            if (!url) continue;

            let type: LovartProjectImage['type'] = 'unknown';
            if (url.includes('/artifacts/generator/')) type = 'generator';
            else if (url.includes('/artifacts/user/')) type = 'user';
            else if (url.includes('/artifacts/agent/')) type = 'agent';

            images.push({
                shapeId: s.id || shapeId,
                url,
                w: s.props?.w ?? 0,
                h: s.props?.h ?? 0,
                type,
            });
        }
    }

    return images;
}
