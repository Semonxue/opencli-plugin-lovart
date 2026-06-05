/**
 * `opencli lovart me` — show the logged-in Lovart user identity.
 *
 * Reads the avatar popover that opens from the top-nav avatar trigger.
 * Returns one row with name, email, plan, credits, and a few derived flags
 * (profile_url, signout_visible) so agents can sanity-check the session
 * without scraping arbitrary DOM.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { readLovartMe } from './utils.js';

cli({
    site: 'lovart',
    name: 'me',
    access: 'read',
    description: 'Show the logged-in Lovart user identity (name, email, plan, credits).',
    example: 'opencli lovart me',
    domain: 'www.lovart.ai',
    strategy: Strategy.UI,
    browser: true,
    columns: ['name', 'email', 'plan', 'credits', 'profile_url', 'signout_visible'],
    func: async (page: any) => {
        return readLovartMe(page);
    },
});
