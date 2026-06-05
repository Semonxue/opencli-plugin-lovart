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
