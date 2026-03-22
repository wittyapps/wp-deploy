# wp-deploy

Reusable GitHub Action for deploying WordPress plugins and themes to a server via SCP/SSH.

On every published release in a plugin or theme repo, this action:

1. Downloads the release zip from GitHub.
2. SCPs it to the server.
3. SSHes in to unzip and merge files into the correct `wp-content` directory.

---

## Setup

### 1. Configure org-level secrets

Add the following secrets once in **GitHub Settings → Secrets and variables → Actions** (at the organisation or repository level):

| Secret            | Description                          |
|-------------------|--------------------------------------|
| `SERVER_HOST`     | SSH server hostname or IP address    |
| `SERVER_USER`     | SSH username                         |
| `SERVER_SSH_KEY`  | Full private key (PEM or OpenSSH)    |

### 2. Add the workflow to your plugin/theme repo

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

### 3. Publish a release

Create and publish a release in your plugin/theme repo. The action will:

- Deploy a **plugin** to `/public_html/wp-content/plugins/{repo-name}/`
- Deploy a **theme** to `/public_html/wp-content/themes/{repo-name}/`

Files are merged (existing files are updated, extra files are preserved).

---

## Action inputs

| Input              | Required | Default                    | Description                              |
|--------------------|----------|----------------------------|------------------------------------------|
| `type`             | ✅        | —                          | `plugin` or `theme`                      |
| `ssh_host`         | ✅        | —                          | SSH server hostname or IP                |
| `ssh_user`         | ✅        | —                          | SSH username                             |
| `ssh_private_key`  | ✅        | —                          | SSH private key (PEM or OpenSSH)         |
| `ssh_port`         | ❌        | `22`                       | SSH port                                 |
| `dest_base_path`   | ❌        | `/public_html/wp-content`  | Base path to wp-content on the server    |

---

## Security notes

- The SSH private key is masked via `@actions/core.setSecret` and will never appear in logs.
- `StrictHostKeyChecking=no` is used for SSH/SCP connections. For stricter security, a future `ssh_known_hosts` input could be added to pin the server fingerprint.
- The temporary SSH key file is always deleted in a `finally` block, even when the action fails.

---

## Development

The action is built with [`@vercel/ncc`](https://github.com/vercel/ncc) and the bundled output is committed to `dist/` so no build step is required when the action is called.

```bash
cd .github/actions/deploy
npm install
npm run build   # produces dist/index.js
```
