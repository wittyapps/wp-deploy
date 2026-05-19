'use strict';

const core = require('@actions/core');
const exec = require('@actions/exec');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Escape literal control characters (newlines, carriage returns, tabs, etc.)
 * that appear inside JSON string values. This handles the common case where
 * an SSH private key stored in a GitHub secret retains its literal newlines
 * instead of having them escaped as \n before being embedded in JSON.
 */
function sanitizeJsonControlChars(str) {
  const ESCAPES = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };
  let result = '';
  let inString = false;
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (ch === '\\' && inString) {
      // Already-escaped sequence — keep both the backslash and the next char.
      result += ch + (str[i + 1] || '');
      i += 2;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
    } else if (inString && ESCAPES[ch]) {
      result += ESCAPES[ch];
    } else {
      result += ch;
    }
    i++;
  }
  return result;
}

/**
 * Download a URL to a local file, following redirects.
 * Uses the built-in https/http modules — no extra dependencies.
 * @param {string} url       - URL to download
 * @param {string} destPath  - local file path to write to
 * @param {object} [headers] - optional HTTP request headers (e.g. Authorization)
 */
function download(url, destPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);

    const request = (requestUrl, requestHeaders) => {
      const mod = requestUrl.startsWith('https') ? https : http;
      const parsedUrl = new URL(requestUrl);
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        headers: requestHeaders,
      };
      mod.get(options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow redirect — drop Authorization header when crossing to a
          // different host (e.g. GitHub API → S3 redirect) to avoid leaking
          // the token to a third-party server.
          const redirectUrl = res.headers.location;
          const redirectHost = new URL(redirectUrl).hostname;
          const nextHeaders = redirectHost === parsedUrl.hostname ? requestHeaders : {};
          request(redirectUrl, nextHeaders);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed with status ${res.statusCode}: ${requestUrl}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
      }).on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    };

    request(url, headers);
  });
}

/**
 * Deploy the local zip to a single server.
 * @param {object} server  - { ssh_host, ssh_user, ssh_private_key, ssh_port, dest_base_path }
 * @param {string} localZipPath - path to the downloaded zip on the runner
 * @param {string} repoName     - repository name used as the target folder
 * @param {string} type         - 'plugin' or 'theme'
 */
async function deployToServer(server, localZipPath, repoName, type) {
  const { ssh_host, ssh_user, ssh_private_key, ssh_port = '22', dest_base_path = '/public_html/wp-content' } = server;

  if (!ssh_host) throw new Error('Missing required server field: ssh_host');
  if (!ssh_user) throw new Error('Missing required server field: ssh_user');
  if (!ssh_private_key) throw new Error('Missing required server field: ssh_private_key');

  // Mask the private key so it never appears in logs
  core.setSecret(ssh_private_key);

  const tmpDir = os.tmpdir();
  const keyPath = path.join(tmpDir, `deploy_key_${Date.now()}_${Math.random().toString(36).slice(2)}`);

  try {
    // ── Write SSH private key to a temp file (chmod 600) ─────────────────────
    const keyContent = ssh_private_key.endsWith('\n') ? ssh_private_key : `${ssh_private_key}\n`;
    fs.writeFileSync(keyPath, keyContent, { mode: 0o600 });

    const remoteZip = `/tmp/${repoName}.zip`;
    const remoteExtractDir = `/tmp/${repoName}-extract`;
    const typeFolder = type === 'plugin' ? 'plugins' : 'themes';
    const targetDir = `${dest_base_path}/${typeFolder}/${repoName}`;

    // ── SCP: upload zip to /tmp/{repo}.zip on the server ─────────────────────
    core.info(`Uploading ${localZipPath} → ${ssh_user}@${ssh_host}:${remoteZip} …`);
    await exec.exec('scp', [
      '-i', keyPath,
      '-P', ssh_port,
      '-o', 'StrictHostKeyChecking=no',
      localZipPath,
      `${ssh_user}@${ssh_host}:${remoteZip}`,
    ]);
    core.info('Upload complete.');

    // ── SSH: unzip, detect top-level dir, merge into wp-content ──────────────
    const sshCommand = [
      `unzip -o ${remoteZip} -d ${remoteExtractDir}`,
      `TOP=$(ls -1 ${remoteExtractDir} | head -n 1)`,
      `mkdir -p ${targetDir}`,
      `cp -rT ${remoteExtractDir}/"$TOP"/ ${targetDir}/`,
      `rm -rf ${remoteZip} ${remoteExtractDir}`,
    ].join(' && ');

    core.info(`Running deploy on ${ssh_host} …`);
    await exec.exec('ssh', [
      '-i', keyPath,
      '-p', ssh_port,
      '-o', 'StrictHostKeyChecking=no',
      `${ssh_user}@${ssh_host}`,
      sshCommand,
    ]);
    core.info(`Deploy complete. Files merged into ${targetDir}`);

  } finally {
    // Always remove the temp SSH key — even if an earlier step threw
    fs.unlink(keyPath, () => {});
  }
}

async function run() {
  try {
    // ── 1. Read inputs ────────────────────────────────────────────────────────
    const githubToken = core.getInput('github_token');
    const type = core.getInput('type', { required: true });

    if (!['plugin', 'theme'].includes(type)) {
      throw new Error(`Input 'type' must be 'plugin' or 'theme', got: '${type}'`);
    }

    // Build the list of servers: prefer the `servers` JSON input, else fall
    // back to the individual single-server inputs for backward compatibility.
    const serversInput = core.getInput('servers');
    let servers;

    if (serversInput && serversInput.trim() !== '') {
      try {
        servers = JSON.parse(serversInput);
      } catch (e) {
        // SSH private keys often contain literal newlines which are invalid in
        // JSON strings. Sanitize by escaping control characters inside string
        // literals and retry before giving up.
        try {
          servers = JSON.parse(sanitizeJsonControlChars(serversInput));
        } catch (_e2) {
          throw new Error(`Failed to parse 'servers' input as JSON: ${e.message}`);
        }
      }
      if (!Array.isArray(servers) || servers.length === 0) {
        throw new Error("Input 'servers' must be a non-empty JSON array.");
      }
    } else {
      // Single-server mode — require the individual fields
      const sshHost = core.getInput('ssh_host', { required: true });
      const sshUser = core.getInput('ssh_user', { required: true });
      const sshPrivateKey = core.getInput('ssh_private_key', { required: true });
      const sshPort = core.getInput('ssh_port') || '22';
      const destBasePath = core.getInput('dest_base_path') || '/public_html/wp-content';

      servers = [{
        ssh_host: sshHost,
        ssh_user: sshUser,
        ssh_private_key: sshPrivateKey,
        ssh_port: sshPort,
        dest_base_path: destBasePath,
      }];
    }

    // ── 2. Get release zip URL from the workflow event context ────────────────
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath) {
      throw new Error('GITHUB_EVENT_PATH environment variable is not set.');
    }
    const payload = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    if (!payload.release) {
      throw new Error(
        "This action must be triggered by a 'release' event. No release payload found."
      );
    }
    const zipUrl = payload.release.zipball_url;
    core.info(`Release zip URL: ${zipUrl}`);

    // ── 3. Determine repo name (used as target folder and zip filename) ───────
    const githubRepo = process.env.GITHUB_REPOSITORY; // "owner/repo"
    if (!githubRepo) {
      throw new Error('GITHUB_REPOSITORY environment variable is not set.');
    }
    const repoName = githubRepo.split('/')[1];
    core.info(`Repository name: ${repoName}`);

    // ── 4. Download the zip once (shared across all servers) ─────────────────
    const tmpDir = os.tmpdir();
    const localZipPath = path.join(tmpDir, `${repoName}.zip`);
    core.info(`Downloading zip to ${localZipPath} …`);
    const downloadHeaders = githubToken ? { Authorization: `Bearer ${githubToken}` } : {};
    await download(zipUrl, localZipPath, downloadHeaders);
    core.info('Download complete.');

    // ── 5. Deploy to each server in sequence ─────────────────────────────────
    core.info(`Deploying to ${servers.length} server(s) …`);
    for (let i = 0; i < servers.length; i++) {
      const server = servers[i];
      core.info(`--- Server ${i + 1} of ${servers.length}: ${server.ssh_host} ---`);
      await deployToServer(server, localZipPath, repoName, type);
    }

    // ── 6. Clean up local temp zip ────────────────────────────────────────────
    fs.unlink(localZipPath, () => {});

  } catch (err) {
    core.setFailed(err.message);
  }
}

run().catch((err) => {
  core.setFailed(err.message);
});
