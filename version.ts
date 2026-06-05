/**
 * `opencli lovart version` — print the plugin version.
 *
 * Reads the version from `opencli-plugin.json` so the number is always
 * in sync with what `opencli plugin list` reports.
 */
import { cli } from '@jackwener/opencli/registry';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(__dirname, 'opencli-plugin.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { version?: string };

cli({
    site: 'lovart',
    name: 'version',
    access: 'read',
    description: 'Show the plugin version.',
    domain: 'www.lovart.ai',
    columns: ['name', 'version'],
    func: async () => {
        return [{
            name: manifest.name ?? 'opencli-plugin-lovart',
            version: manifest.version ?? 'unknown',
        }];
    },
});
