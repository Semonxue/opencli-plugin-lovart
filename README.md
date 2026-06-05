# opencli-plugin-lovart

Lovart (lovart.ai) adapter for [OpenCLI](https://github.com/jackwener/OpenCLI). Currently ships two read-only commands:

- `opencli lovart me` — read the logged-in user identity (name, email, plan, credits) from the avatar popover.
- `opencli lovart projects` — list projects on the `/zh/projects` grid (name + last-updated).

Strategy: `UI` — Lovart is a React SPA with no public API; the adapter reads `[data-testid="avatar-popover-content"]` and `[role="grid"] [role="gridcell"]` directly.

## Install

```sh
# from a local clone
opencli plugin install file:///Users/semonxue/Workplace/Works/ai-dev/lovart-opencli-plugin

# or from a git repo
opencli plugin install git@github.com:<you>/opencli-plugin-lovart.git
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

## Update after edits

```sh
opencli plugin update lovart
```

Re-transpiles `.ts` → `.js` and refreshes the symlink. `opencli` picks up the new commands on the next call.

## Uninstall

```sh
opencli plugin uninstall lovart
```
