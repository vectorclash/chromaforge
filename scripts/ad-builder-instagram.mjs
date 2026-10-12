// Posting a Reel from the local ad builder to @chromaforge.app, for scripts/ad-builder-dev.mjs.
//
// Instagram's API (the Instagram Login flavour: no Facebook Page involved) cannot take a video
// upload directly -- it FETCHES the file from a public URL. So the dev server copies the MP4 and
// its cover to a temporary folder on chromaforge.app over SSH (the same Hostinger account the
// site deploys to), asks Instagram to fetch them, and deletes them once the post is live. Nothing
// goes through GitHub or the site's deploy; the folder is excluded from the deploy's
// `rsync --delete-after`, which would otherwise wipe a file mid-post.
//
//   GET  /__ads/instagram/status        what is set up, and the account it posts to
//   POST /__ads/instagram/file          raw video/mp4 or image/jpeg -> { id } (kept in .ads/outbox)
//   POST /__ads/instagram/post          { video, cover?, caption, shareToFeed, trial } -> { job }
//   GET  /__ads/instagram/jobs/<id>     { stage, error?, permalink? }
//
// The token never reaches the browser. It comes from INSTAGRAM_ACCESS_TOKEN in .env.local; a
// renewed copy is kept in .ads/instagram-token.json and used for as long as .env.local still holds
// the token it was renewed from (pasting a new token there makes the new one win).
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadEnv } from 'vite';

const run = promisify(execFile);

const API = 'https://graph.instagram.com/v25.0';
// Fixed account facts, the same ones .github/workflows/deploy.yml uses. Only the key is secret.
const SSH_HOST = '45.137.159.160';
const SSH_PORT = '65002';
const SSH_USER = 'u141529136';
const HOST_KEY = `[${SSH_HOST}]:${SSH_PORT} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIN9ovrpXkuA4/afZmktfMJGvkX5pavmxwZP13E4lACJz`;
const REMOTE_DIR = 'domains/chromaforge.app/public_html/_ig';
const PUBLIC_BASE = 'https://chromaforge.app/_ig';
const DEFAULT_KEY = path.join(os.homedir(), '.ssh', 'chromaforge_hostinger');

const RENEW_AFTER_MS = 7 * 24 * 3600 * 1000;
const POLL_MS = 15_000;
const POLL_LIMIT_MS = 10 * 60_000;
// A file left behind by a post that died midway (dev server stopped, say) is swept on the next post.
const STALE_MINUTES = 120;
const FILE_TYPES = { 'video/mp4': '.mp4', 'image/jpeg': '.jpg' };
export const MAX_POST_FILE_BYTES = 300 * 1024 * 1024; // Instagram's own Reel limit

const sha = s => createHash('sha256').update(s).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function createInstagramPoster({ root, mode }) {
  const adsDir = path.join(root, '.ads');
  const outbox = path.join(adsDir, 'outbox');
  const tokenFile = path.join(adsDir, 'instagram-token.json');
  const knownHosts = path.join(adsDir, 'known_hosts');
  const jobs = new Map();
  let account = null; // { id, username }, looked up once per token

  const env = () => loadEnv(mode, root, '');
  const keyPath = () => {
    const k = env().CF_SSH_KEY || DEFAULT_KEY;
    return k.startsWith('~') ? path.join(os.homedir(), k.slice(1)) : k;
  };

  // ── Token ───────────────────────────────────────────────────────────────────
  async function token() {
    const fromEnv = (env().INSTAGRAM_ACCESS_TOKEN || '').trim();
    if (!fromEnv) throw new Error('INSTAGRAM_ACCESS_TOKEN is not set in .env.local.');
    let saved = null;
    try {
      saved = JSON.parse(await fs.readFile(tokenFile, 'utf8'));
    } catch {
      /* none yet */
    }
    const current =
      saved && saved.from === sha(fromEnv)
        ? saved
        : { token: fromEnv, from: sha(fromEnv), renewedAt: 0 };
    if (Date.now() - current.renewedAt > RENEW_AFTER_MS) {
      // Allowed once a token is a day old; a fresh one is refused, which is fine -- try next time.
      const r = await fetch(
        `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(current.token)}`
      );
      const body = await r.json().catch(() => ({}));
      if (r.ok && body.access_token) {
        Object.assign(current, {
          token: body.access_token,
          renewedAt: Date.now(),
          expiresIn: body.expires_in
        });
        await fs.mkdir(adsDir, { recursive: true });
        await fs.writeFile(tokenFile, JSON.stringify(current, null, 2), { mode: 0o600 });
      }
    }
    if (account?.tokenHash !== sha(current.token)) account = null;
    return current.token;
  }

  async function graph(method, pathname, params = {}) {
    const access = await token();
    const url = new URL(`${API}/${pathname}`);
    const init = { method };
    if (method === 'GET') {
      for (const [k, v] of Object.entries({ ...params, access_token: access }))
        url.searchParams.set(k, v);
    } else {
      init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      init.body = new URLSearchParams({ ...params, access_token: access });
    }
    const r = await fetch(url, init);
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.error) {
      const e = body.error || {};
      throw new Error(e.error_user_msg || e.message || `Instagram answered ${r.status}`);
    }
    return body;
  }

  async function me() {
    if (account) return account;
    const access = await token();
    const body = await graph('GET', 'me', { fields: 'user_id,username' });
    account = { id: body.user_id || body.id, username: body.username, tokenHash: sha(access) };
    return account;
  }

  // ── SSH ─────────────────────────────────────────────────────────────────────
  async function sshArgs() {
    await fs.mkdir(adsDir, { recursive: true });
    // Pinned, like the deploy: a server that answers with a different key is refused, not trusted.
    await fs.writeFile(knownHosts, HOST_KEY + '\n');
    return [
      '-i',
      keyPath(),
      '-o',
      'BatchMode=yes',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'ConnectTimeout=15',
      '-o',
      `UserKnownHostsFile=${knownHosts}`,
      '-o',
      'StrictHostKeyChecking=yes'
    ];
  }
  const target = `${SSH_USER}@${SSH_HOST}`;
  const ssh = async command =>
    run('ssh', [...(await sshArgs()), '-p', SSH_PORT, target, command], { timeout: 60_000 });
  const scp = async (files, dir) =>
    run('scp', [...(await sshArgs()), '-P', SSH_PORT, ...files, `${target}:${dir}/`], {
      timeout: 10 * 60_000
    });

  // ── Routes ──────────────────────────────────────────────────────────────────
  async function status() {
    const out = {
      token: false,
      sshKey: existsSync(keyPath()),
      sshKeyPath: keyPath(),
      account: null,
      error: null
    };
    try {
      out.token = !!(env().INSTAGRAM_ACCESS_TOKEN || '').trim();
      if (out.token) {
        const a = await me();
        out.account = a.username;
        const limit = await graph('GET', `${a.id}/content_publishing_limit`, {
          fields: 'quota_usage,config'
        }).catch(() => null);
        const q = limit?.data?.[0];
        if (q) out.quota = { used: q.quota_usage, total: q.config?.quota_total };
      }
    } catch (e) {
      out.error = e.message;
    }
    return out;
  }

  async function keepFile(bytes, type) {
    const ext = FILE_TYPES[type];
    if (!ext) throw new Error(`Unsupported type ${type}`);
    await fs.mkdir(outbox, { recursive: true });
    // Random, not content-hashed: the name becomes a public URL for a few minutes, so it must
    // not be guessable from the file.
    const id = randomBytes(16).toString('hex') + ext;
    await fs.writeFile(path.join(outbox, id), bytes);
    return id;
  }

  const outboxFile = id => {
    if (!/^[0-9a-f]{32}\.(mp4|jpg)$/.test(id || '')) throw new Error('Bad file id');
    const f = path.join(outbox, id);
    if (!existsSync(f)) throw new Error('That file is gone; export again.');
    return f;
  };

  function startPost({ video, cover, caption, shareToFeed = true, trial = false }) {
    const files = [outboxFile(video), ...(cover ? [outboxFile(cover)] : [])];
    if (typeof caption !== 'string' || caption.length > 2200)
      throw new Error('Caption must be at most 2,200 characters.');
    const id = randomBytes(8).toString('hex');
    const job = {
      stage: 'Uploading to chromaforge.app',
      error: null,
      permalink: null,
      done: false
    };
    jobs.set(id, job);

    (async () => {
      let uploaded = false;
      try {
        const a = await me();
        await ssh(
          `mkdir -p ${REMOTE_DIR} && find ${REMOTE_DIR} -type f -mmin +${STALE_MINUTES} -delete`
        );
        await scp(files, REMOTE_DIR);
        uploaded = true;

        // Instagram's own fetch fails with an unhelpful error, so prove the URL works first.
        const videoUrl = `${PUBLIC_BASE}/${video}`;
        const head = await fetch(videoUrl, { method: 'HEAD' });
        if (!head.ok || !/video\/mp4/.test(head.headers.get('content-type') || '')) {
          throw new Error(
            `${videoUrl} answered ${head.status} ${head.headers.get('content-type') || ''}`
          );
        }

        job.stage = 'Instagram is fetching the video';
        const params = {
          media_type: 'REELS',
          video_url: videoUrl,
          caption,
          share_to_feed: String(!!shareToFeed)
        };
        if (cover) params.cover_url = `${PUBLIC_BASE}/${cover}`;
        if (trial) params.trial_params = JSON.stringify({ graduation_strategy: 'SS_PERFORMANCE' });
        const container = await graph('POST', `${a.id}/media`, params);

        job.stage = 'Instagram is processing';
        const started = Date.now();
        for (;;) {
          await sleep(POLL_MS);
          const s = await graph('GET', container.id, { fields: 'status_code,status' });
          if (s.status_code === 'FINISHED') break;
          if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') {
            throw new Error(`Instagram could not process the video: ${s.status || s.status_code}`);
          }
          if (Date.now() - started > POLL_LIMIT_MS)
            throw new Error('Instagram took over 10 minutes; nothing was posted.');
        }

        job.stage = 'Publishing';
        const published = await graph('POST', `${a.id}/media_publish`, {
          creation_id: container.id
        });
        const media = await graph('GET', published.id, { fields: 'permalink' }).catch(() => ({}));
        job.permalink = media.permalink || null;
        job.mediaId = published.id;
        job.stage = 'Published';
      } catch (e) {
        job.error = e.stderr?.toString().trim() || e.message;
        job.stage = 'Failed';
      } finally {
        if (uploaded) {
          const names = [video, cover]
            .filter(Boolean)
            .map(n => `${REMOTE_DIR}/${n}`)
            .join(' ');
          await ssh(`rm -f ${names}`).catch(e => {
            job.cleanupError = `Couldn't delete the temporary files on the server (${e.message}); the next post sweeps them.`;
          });
        }
        await Promise.all(files.map(f => fs.rm(f, { force: true })));
        job.done = true;
      }
    })();
    return id;
  }

  return { status, keepFile, startPost, job: id => jobs.get(id) || null };
}
