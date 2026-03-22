'use strict';

const core = require('@actions/core');
const exec = require('@actions/exec');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Download a URL to a local file, following redirects.
 * Uses the built-in https/http modules — no extra dependencies.
 */
function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);

    const request = (requestUrl) => {
      const mod = requestUrl.startsWith('https') ? https : http;
      mod.get(requestUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow redirect
          request(res.headers.location);
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

    request(url);
  });
}

async function run() {
  let keyPath = null;

  try {
    // ── 1. Read inputs ────────────────────────────────────────────────────────
    const type = core.getInput('type', { required: true });
    const sshHost = core.getInput('ssh_host', { required: true });
    const sshUser = core.getInput('ssh_user', { required: true });
    const sshPrivateKey = core.getInput('ssh_private_key', { required: true });
    const sshPort = core.getInput('ssh_port') || '22';
    const destBasePath = core.getInput('dest_base_path') || '/public_html/wp-content';

    // Mask the private key so it never appears in logs
    core.setSecret(sshPrivateKey);

    if (!['plugin', 'theme'].includes(type)) {
      throw new Error(`Input 'type' must be 'plugin' or 'theme', got: '${type}'`);
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

    // ── 4. Download the zip to a local temp file ──────────────────────────────
    const tmpDir = os.tmpdir();
    const localZipPath = path.join(tmpDir, `${repoName}.zip`);
    core.info(`Downloading zip to ${localZipPath} …`);
    await download(zipUrl, localZipPath);
    core.info('Download complete.');

    // ── 5. Write SSH private key to a temp file (chmod 600) ───────────────────
    keyPath = path.join(tmpDir, `deploy_key_${Date.now()}`);
    // Ensure the key ends with a newline (required for OpenSSH)
    const keyContent = sshPrivateKey.endsWith('\n') ? sshPrivateKey : `${sshPrivateKey}\n`;
    fs.writeFileSync(keyPath, keyContent, { mode: 0o600 });

    // ── 6. SCP: upload zip to /tmp/{repo}.zip on the server ───────────────────
    const remoteZip = `/tmp/${repoName}.zip`;
    const remoteExtractDir = `/tmp/${repoName}-extract`;
    const typeFolder = type === 'plugin' ? 'plugins' : 'themes';
    const targetDir = `${destBasePath}/${typeFolder}/${repoName}`;

    core.info(`Uploading ${localZipPath} → ${sshUser}@${sshHost}:${remoteZip} …`);
    await exec.exec('scp', [
      '-i', keyPath,
      '-P', sshPort,
      '-o', 'StrictHostKeyChecking=no',
      localZipPath,
      `${sshUser}@${sshHost}:${remoteZip}`,
    ]);
    core.info('Upload complete.');

    // ── 7. SSH: unzip, detect top-level dir, merge into wp-content ────────────
    // Compound remote command:
    //   a) unzip the archive into a staging dir
    //   b) find the single top-level directory GitHub always creates
    //   c) cp -rT to merge into the target plugin/theme directory
    //   d) clean up the remote temp files
    const sshCommand = [
      `unzip -o ${remoteZip} -d ${remoteExtractDir}`,
      `TOP=$(ls -1 ${remoteExtractDir} | head -n 1)`,
      `mkdir -p ${targetDir}`,
      `cp -rT ${remoteExtractDir}/"$TOP"/ ${targetDir}/`,
      `rm -rf ${remoteZip} ${remoteExtractDir}`,
    ].join(' && ');

    core.info(`Running deploy on ${sshHost} …`);
    await exec.exec('ssh', [
      '-i', keyPath,
      '-p', sshPort,
      '-o', 'StrictHostKeyChecking=no',
      `${sshUser}@${sshHost}`,
      sshCommand,
    ]);
    core.info(`Deploy complete. Files merged into ${targetDir}`);

    // ── 8. Clean up local temp zip ────────────────────────────────────────────
    fs.unlink(localZipPath, () => {});

  } finally {
    // Always remove the temp SSH key — even if an earlier step threw
    if (keyPath) {
      fs.unlink(keyPath, () => {});
    }
  }
}

run().catch((err) => {
  core.setFailed(err.message);
});
