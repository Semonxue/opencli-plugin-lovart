# opencli-plugin-lovart

Lovart (lovart.ai) adapter for [OpenCLI](https://github.com/jackwener/OpenCLI). Currently ships four read-only commands:

- `opencli lovart me` — read the logged-in user identity (name, email, plan, credits) from the avatar popover.
- `opencli lovart projects` — list projects on the `/zh/projects` grid (name + last-updated).
- `opencli lovart project <id>` — fetch a single project: asset counts and URLs (images, videos, uploads).
- `opencli lovart version` — print the plugin version (read from `opencli-plugin.json`).

Strategy: `UI` for `me`, `COOKIE` for `projects` and `project` — Lovart is a React SPA with no public API; the avatar / grid selectors are read directly, while project / canvas data is fetched through internal endpoints using the `usertoken` cookie (forwarded as a `token` header).

## Install

```sh
# from the public repo
opencli plugin install git@github.com:Semonxue/opencli-plugin-lovart.git

# or from a local clone (replace the path with wherever you put it)
opencli plugin install file:///path/to/opencli-plugin-lovart
```

Then run `opencli lovart --help` to confirm registration.

## Verify

```sh
opencli lovart me                # 1 row: name/email/plan/credits
opencli lovart projects          # default: 5 most-recently-updated projects
opencli lovart projects --limit 20 --order asc
opencli lovart projects -f json
```

`me` opens a Chrome tab (background), navigates to the home page, clicks the avatar trigger, and reads the popover.
`projects` rides the `canva/lovartProjectList` endpoint via the `usertoken` cookie (forwarded as a `token` header) and returns one row per project with the following columns:

| column        | meaning |
| ---           | --- |
| `id`          | 32-char projectId used in the canvas URL |
| `url`         | fully-qualified link to open the project in a browser |
| `name`        | project title |
| `picCount`    | number of generated images inside the project |
| `isFavorite`  | whether the user has starred the project |
| `projectType` | Lovart-internal type id |
| `updated`     | last-updated time, formatted `MMM D, YYYY` |

The `projectCoverList[]` from the API is intentionally dropped — projects carry several previews and exposing only the first one would be misleading; agents that need the full cover set can fetch the project page through `url`.

Pass `--order asc` to flip the sort; pass `--limit N` to change the slice count (default 5). The endpoint is paginated internally so the adapter can reach every project, not just the ones currently painted in the grid.

## `opencli lovart project <id>`

Fetch a single project and return its assets. The first row is a one-line summary (`name · counts · info`); subsequent rows are the assets themselves.

```sh
opencli lovart project <projectId>                  # summary only (no asset list)
opencli lovart project <projectId> --list all       # summary + all assets
opencli lovart project <projectId> --list image     # only AI-generated images
opencli lovart project <projectId> --list video     # only generated videos
opencli lovart project <projectId> --list upload    # only user uploads
opencli lovart project <projectId> --list all --limit 50
```

**Arguments**

| Name | Description |
| --- | --- |
| `projectId` | 32-char hex project ID (from `opencli lovart projects` or the canvas URL). |

**Command options**

| Flag | Description | Default | Choices |
| --- | --- | --- | --- |
| `--list` | List assets: `all` / `image` / `video` / `upload`. Plurals (`images`, `videos`, `uploads`) also accepted. Omit for summary only. | `""` | — |
| `--canvas` | Show raw canvas JSON. Pass `--canvas true` to enable. | `false` | — |
| `--export-canvas` | Path to write the full canvas JSON (`canvasDataV1`) to a local `.json` file. | `""` | — |
| `--limit` | Max asset rows to list. | `10` | — |
| `--export-page` | Path to dump all raw page state for debugging. | `""` | — |

**Examples**

```sh
# Default: summary only
opencli lovart project <projectId>

# List all assets (summary + 10 rows)
opencli lovart project <projectId> --list all

# Only user uploads (plural also works)
opencli lovart project <projectId> --list uploads

# Show more rows
opencli lovart project <projectId> --list all --limit 50

# Raw canvas JSON
opencli lovart project <projectId> --canvas true

# Save canvas JSON to file
opencli lovart project <projectId> --export-canvas /tmp/canvas.json

# Debug: dump full page state
opencli lovart project <projectId> --export-page /tmp/page-state.json
```

Under the hood the command calls `canva/project/queryProject`, decompresses the `SHAKKERDATA://` canvas blob, and walks the tldraw `document.store` to bucket every `c-image` / `c-video` / `c-group` shape into one of three categories: AI-generated (`/artifacts/generator/`), user uploads (`/artifacts/user/`), or groups. The `usertoken` cookie is the only auth — no page navigation is required.

## Update after edits

```sh
opencli plugin update lovart
```

Re-transpiles `.ts` → `.js` and refreshes the symlink. `opencli` picks up the new commands on the next call.

## Uninstall

```sh
opencli plugin uninstall lovart
```
