# wp-deploy

Reusable GitHub Action for deploying WordPress plugins and themes to one or more servers via SCP/SSH.

On every published release in a plugin or theme repo, this action:

1. Downloads the release zip from GitHub.
2. SCPs it to each server.
3. SSHes in to unzip and merge files into the correct `wp-content` directory.

Releases created from the **`develop`** branch are deployed to **staging** servers.  
Releases created from the **`master`** branch are deployed to **production** servers.

---

## Setup

### 1. Configure org-level secrets

Add two secrets in **GitHub Settings → Secrets and variables → Actions** (at the organisation or repository level), each containing a JSON array of server objects:

| Secret                   | Description                        |
|--------------------------|------------------------------------|
| `STAGING_SERVERS_JSON`   | Servers to deploy to from `develop` |
| `PRODUCTION_SERVERS_JSON`| Servers to deploy to from `master`  |

Example value for each secret:

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

Each object supports: `ssh_host`, `ssh_user`, `ssh_private_key` (required); `ssh_port` (default: `22`), `dest_base_path` (default: `/public_html/wp-content`) (optional).

### 2. Add the workflow to your plugin/theme repo

Copy `example-workflow/deploy.yml` into your plugin or theme repository at `.github/workflows/deploy.yml` and set the `type` input:

```yaml
name: Deploy to WordPress

on:
  release:
    types: [published]

jobs:
  deploy-staging:
    if: github.event.release.target_commitish == 'develop'
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: wittyapps/wp-deploy/.github/actions/deploy@main
        with:
          type: plugin        # or 'theme'
          servers: ${{ secrets.STAGING_SERVERS_JSON }}
          github_token: ${{ secrets.GITHUB_TOKEN }}

  deploy-production:
    if: github.event.release.target_commitish == 'master'
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: wittyapps/wp-deploy/.github/actions/deploy@main
        with:
          type: plugin        # or 'theme'
          servers: ${{ secrets.PRODUCTION_SERVERS_JSON }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

The `target_commitish` field on a GitHub Release is the branch the release was created from. Only the job matching the release's source branch will run — the other will be skipped.

### 3. Publish a release

Create and publish a release in your plugin/theme repo, making sure to set the **target branch** correctly:

- Releases targeting `develop` → deploy to staging
- Releases targeting `master` → deploy to production

The action will:

- Deploy a **plugin** to `/public_html/wp-content/plugins/{repo-name}/`
- Deploy a **theme** to `/public_html/wp-content/themes/{repo-name}/`

Files are merged (existing files are updated, extra files are preserved). When deploying to multiple servers the zip is downloaded once and then uploaded to each server in sequence.

---

## Action inputs

| Input              | Required | Default                    | Description                                                                 |
|--------------------|----------|----------------------------|-----------------------------------------------------------------------------|
| `type`             | ✅        | —                          | `plugin` or `theme`                                                         |
| `servers`          | ✅        | —                          | JSON array of server objects (see above).                                   |
| `github_token`     | ❌        | `${{ github.token }}`      | Token used to authenticate the release zip download. Required for private repos — pass `${{ secrets.GITHUB_TOKEN }}` and ensure the job has `permissions: contents: read`. |
| `ssh_host`         | ❌        | —                          | SSH server hostname or IP (single-server fallback)                          |
| `ssh_user`         | ❌        | —                          | SSH username (single-server fallback)                                       |
| `ssh_private_key`  | ❌        | —                          | SSH private key (PEM or OpenSSH) (single-server fallback)                   |
| `ssh_port`         | ❌        | `22`                       | SSH port (single-server fallback)                                           |
| `dest_base_path`   | ❌        | `/public_html/wp-content`  | Base path to wp-content on the server (single-server fallback)              |

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
