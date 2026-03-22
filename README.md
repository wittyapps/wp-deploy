# wp-deploy

Reusable GitHub Action for deploying WordPress plugins and themes to one or more servers via SCP/SSH.

On every published release in a plugin or theme repo, this action:

1. Downloads the release zip from GitHub.
2. SCPs it to each server.
3. SSHes in to unzip and merge files into the correct `wp-content` directory.

---

## Setup

### 1. Configure org-level secrets

#### Single server

Add the following secrets once in **GitHub Settings → Secrets and variables → Actions** (at the organisation or repository level):

| Secret            | Description                          |
|-------------------|--------------------------------------|
| `SERVER_HOST`     | SSH server hostname or IP address    |
| `SERVER_USER`     | SSH username                         |
| `SERVER_SSH_KEY`  | Full private key (PEM or OpenSSH)    |

#### Multiple servers

Create a single secret that contains a JSON array of server objects, e.g. `SERVERS_JSON`:

```json
[
  {
    "ssh_host": "server1.example.com",
    "ssh_user": "deploy",
    "ssh_private_key": "<PRIVATE KEY>"
  },
  {
    "ssh_host": "server2.example.com",
    "ssh_user": "deploy",
    "ssh_private_key": "<PRIVATE KEY>",
    "ssh_port": "2222",
    "dest_base_path": "/var/www/wp-content"
  }
]
```

Each object in the array supports the same fields as the single-server inputs (`ssh_host`, `ssh_user`, `ssh_private_key`, `ssh_port`, `dest_base_path`). `ssh_host`, `ssh_user`, and `ssh_private_key` are required per server; the rest are optional and fall back to their defaults.

### 2. Add the workflow to your plugin/theme repo

#### Single server

Copy `example-workflow/deploy.yml` into your plugin or theme repository at `.github/workflows/deploy.yml` and set the `type` input:

```yaml
name: Deploy to WordPress

on:
  release:
    types: [published]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: wittyapps/wp-deploy/.github/actions/deploy@main
        with:
          type: plugin        # or 'theme'
          ssh_host: ${{ secrets.SERVER_HOST }}
          ssh_user: ${{ secrets.SERVER_USER }}
          ssh_private_key: ${{ secrets.SERVER_SSH_KEY }}
```

#### Multiple servers

When `servers` is provided the individual `ssh_host` / `ssh_user` / `ssh_private_key` inputs are ignored, so you only need one step regardless of how many servers you have:

```yaml
name: Deploy to WordPress

on:
  release:
    types: [published]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: wittyapps/wp-deploy/.github/actions/deploy@main
        with:
          type: plugin        # or 'theme'
          servers: ${{ secrets.SERVERS_JSON }}
```

### 3. Publish a release

Create and publish a release in your plugin/theme repo. The action will:

- Deploy a **plugin** to `/public_html/wp-content/plugins/{repo-name}/`
- Deploy a **theme** to `/public_html/wp-content/themes/{repo-name}/`

Files are merged (existing files are updated, extra files are preserved). When deploying to multiple servers the zip is downloaded once and then uploaded to each server in sequence.

---

## Action inputs

| Input              | Required | Default                    | Description                                                                 |
|--------------------|----------|----------------------------|-----------------------------------------------------------------------------|
| `type`             | ✅        | —                          | `plugin` or `theme`                                                         |
| `servers`          | ❌        | —                          | JSON array of server objects (see above). Overrides single-server inputs.   |
| `ssh_host`         | ✅*       | —                          | SSH server hostname or IP (single-server mode)                              |
| `ssh_user`         | ✅*       | —                          | SSH username (single-server mode)                                           |
| `ssh_private_key`  | ✅*       | —                          | SSH private key (PEM or OpenSSH) (single-server mode)                      |
| `ssh_port`         | ❌        | `22`                       | SSH port (single-server mode)                                               |
| `dest_base_path`   | ❌        | `/public_html/wp-content`  | Base path to wp-content on the server (single-server mode)                  |

\* Required when `servers` is not provided.

---

## Security notes

- All SSH private keys are masked via `@actions/core.setSecret` and will never appear in logs.
- `StrictHostKeyChecking=no` is used for SSH/SCP connections. For stricter security, a future `ssh_known_hosts` input could be added to pin the server fingerprint.
- Each temporary SSH key file is always deleted in a `finally` block, even when the action fails.

---

## Development

The action is built with [`@vercel/ncc`](https://github.com/vercel/ncc) and the bundled output is committed to `dist/` so no build step is required when the action is called.

```bash
cd .github/actions/deploy
npm install
npm run build   # produces dist/index.js
```
