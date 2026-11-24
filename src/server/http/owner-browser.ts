import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { join } from 'node:path';
import type { Context, MiddlewareHandler } from 'hono';
import { generateSignedCookie, getSignedCookie } from 'hono/cookie';
import type { ErrorEnvelope } from '../../shared/contracts/errors.ts';
import { FILE_MODE } from '../lib/fsModes.ts';
import type { HttpEnv } from './errors.ts';
import type { TailscaleAccess } from './guards.ts';

export const OWNER_BROWSER_CODE_FILE = 'paseo-browser-code.txt';
const OWNER_COOKIE = 'agent-hq-owner';
const SESSION_SECONDS = 8 * 60 * 60;
const MAX_FORM_BYTES = 1024;
const CODE = /^[A-Za-z0-9_-]{43}$/;
const FORM_CONTENT_TYPE =
  /^application\/x-www-form-urlencoded(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i;
type Destination = '/' | '/sources';

function destination(path: string | null): Destination | null {
  return path === '/' || path === '/sources' ? path : null;
}

function optionalStat(path: string) {
  return lstatSync(path, { throwIfNoEntry: false, bigint: true });
}

const sameInode = (actual: BigIntStats | undefined, expected: BigIntStats) =>
  actual?.dev === expected.dev && actual.ino === expected.ino;

function assertPrivatePath(path: string, expected: BigIntStats): void {
  const refuse = () => new Error('Agent HQ could not verify its private browser unlock code path.');
  if (process.platform === 'darwin') {
    // macOS ACLs can give access beyond POSIX mode bits, including inheritance and file removal.
    // With -e ACLs add lines even when an extended attribute masks the + marker. -B escapes filenames.
    const listing = spawnSync('/bin/ls', ['-delBn', '--', path], {
      encoding: 'utf8',
      env: { LC_ALL: 'C' },
      maxBuffer: 16_384,
      timeout: 2_000,
    });
    if (
      listing.status !== 0 ||
      listing.stderr ||
      !/^[d-][rwxstST-]{9}[@ ] [^\r\n]+\n$/.test(listing.stdout ?? '')
    ) {
      throw refuse();
    }
  }
  const actual = optionalStat(path);
  if (!sameInode(actual, expected) || actual?.ctimeNs !== expected.ctimeNs) throw refuse();
}

function publishCode(dataDir: string, code: string): () => void {
  const directory = optionalStat(dataDir);
  const uid = process.getuid?.();
  if (
    !directory?.isDirectory() ||
    uid === undefined ||
    directory.uid !== BigInt(uid) ||
    (directory.mode & 0o077n) !== 0n
  ) {
    throw new Error('Agent HQ needs a private data folder to open the browser dashboard.');
  }
  assertPrivatePath(dataDir, directory);

  const path = join(dataDir, OWNER_BROWSER_CODE_FILE);
  // A previous process may have exited without cleaning up. Replace only a private file of our format.
  const previous = optionalStat(path);
  if (
    previous &&
    (!previous.isFile() ||
      previous.uid !== directory.uid ||
      previous.nlink !== 1n ||
      (previous.mode & 0o777n) !== BigInt(FILE_MODE) ||
      previous.size !== 44n)
  ) {
    throw new Error('Agent HQ could not replace its private browser unlock code file.');
  }
  if (previous) {
    assertPrivatePath(path, previous);
    if (!/^[A-Za-z0-9_-]{43}\n$/.test(readFileSync(path, 'utf8'))) {
      throw new Error('Agent HQ could not replace its private browser unlock code file.');
    }
  }

  const temporary = `${path}.${randomUUID()}`;
  const fd = openSync(temporary, 'wx', FILE_MODE);
  let created: BigIntStats | undefined;
  let published = false;
  try {
    try {
      fchmodSync(fd, FILE_MODE);
      created = fstatSync(fd, { bigint: true });
      const currentDir = optionalStat(dataDir);
      if (
        !currentDir ||
        !sameInode(currentDir, directory) ||
        (currentDir.mode & 0o077n) !== 0n ||
        currentDir.uid !== directory.uid ||
        !created.isFile() ||
        created.uid !== directory.uid ||
        created.nlink !== 1n ||
        (created.mode & 0o777n) !== BigInt(FILE_MODE)
      ) {
        throw new Error('Agent HQ could not verify its private browser unlock code path.');
      }
      assertPrivatePath(dataDir, currentDir);
      // Check the empty file through its path, then match that path to the opened descriptor.
      assertPrivatePath(temporary, created);
      writeFileSync(fd, `${code}\n`);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    published = true;
  } finally {
    if (!published && created && sameInode(optionalStat(temporary), created)) unlinkSync(temporary);
  }

  const own = lstatSync(path, { bigint: true });
  return () => {
    const found = optionalStat(path);
    if (sameInode(found, own) && found?.ctimeNs === own.ctimeNs) {
      unlinkSync(path);
    }
  };
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  if (Number(request.headers.get('content-length')) > MAX_FORM_BYTES) return null;
  if (request.body === null) return new URLSearchParams();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_FORM_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new URLSearchParams(
    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
  );
}

function unlockPage(next: Destination, wrongCode = false): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="form-action 'self'">
  <title>Unlock Agent HQ</title>
  <style>
    :root { color-scheme: light dark; font: 1rem/1.5 system-ui, sans-serif; }
    main { box-sizing: border-box; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; }
    h1 { line-height: 1.2; }
    code { overflow-wrap: anywhere; }
    label { display: block; font-weight: 600; }
    input, button { display: block; box-sizing: border-box; font: inherit; padding: .55rem .7rem; margin-top: .5rem; }
    input { width: 100%; }
    button { margin-top: 1rem; }
  </style>
</head>
<body>
  <main>
    <h1>Unlock Agent HQ</h1>
    <p>On the Mac running Paseo, open <code>${OWNER_BROWSER_CODE_FILE}</code> from the daemon owner’s HQ data folder. The default folder is <code>~/Library/Application Support/agent-productivity</code>.</p>
    ${wrongCode ? '<p role="alert" id="code-error">That code did not match. Copy the current code from the host and try again.</p>' : ''}
    <form method="post" action="/unlock">
      <input type="hidden" name="next" value="${next}">
      <label for="code">Browser unlock code</label>
      <input id="code" name="code" type="password" maxlength="43" autocomplete="off" spellcheck="false" required${wrongCode ? ' aria-invalid="true" aria-describedby="code-error"' : ''}>
      <button type="submit">Unlock Agent HQ</button>
    </form>
  </main>
</body>
</html>`;
}

function unlockForm(c: Context<HttpEnv>, next: Destination, wrongCode = false): Response {
  // no-referrer makes browsers send Origin: null on the form POST. Keep same-origin posts identifiable.
  c.header('Referrer-Policy', 'same-origin');
  return c.html(unlockPage(next, wrongCode), 401);
}

const denied = {
  error: {
    code: 'forbidden_origin',
    message: 'Unlock Agent HQ in your browser.',
    retryable: false,
  },
} satisfies ErrorEnvelope;

export function createOwnerBrowserAccess({
  dataDir,
  access,
  now,
}: {
  dataDir: string;
  access: TailscaleAccess;
  now: () => number;
}): { middleware: MiddlewareHandler<HttpEnv>; close(): void } {
  const origin = new URL(`https://${access.host}`).origin;
  const code = randomBytes(32).toString('base64url');
  const signingKey = randomBytes(32).toString('base64url');
  const removeCode = publishCode(dataDir, code);
  let active = true;

  // The outer app checks the Tailnet owner, Host and response headers before this middleware.
  const middleware: MiddlewareHandler<HttpEnv> = async (c, next) => {
    if (!active) return c.json(denied, 401);
    if (c.req.method === 'POST' && c.req.path === '/unlock') {
      // This form is the only POST handled before the normal dashboard CSRF guard.
      if (c.req.header('origin') !== origin) return c.json(denied, 403);
      if (!FORM_CONTENT_TYPE.test(c.req.header('content-type')?.trim() ?? '')) {
        return c.json(denied, 400);
      }
      let form: URLSearchParams | null;
      try {
        form = await readForm(c.req.raw);
      } catch {
        return c.json(denied, 400);
      }
      if (!form) return c.json(denied, 413);
      const entered = form.get('code');
      const requested = destination(form.get('next'));
      if (form.size !== 2 || entered === null || !requested) return c.json(denied, 400);
      if (!active) return c.json(denied, 401);
      if (!CODE.test(entered) || !timingSafeEqual(Buffer.from(entered), Buffer.from(code))) {
        return unlockForm(c, requested, true);
      }
      const cookie = await generateSignedCookie(
        OWNER_COOKIE,
        String(now() + SESSION_SECONDS * 1000),
        signingKey,
        { prefix: 'host', httpOnly: true, sameSite: 'Strict', maxAge: SESSION_SECONDS },
      );
      if (!active) return c.json(denied, 401);
      c.header('Set-Cookie', cookie);
      return c.redirect(requested, 303);
    }

    const expires = await getSignedCookie(c, signingKey, OWNER_COOKIE, 'host');
    if (!active) return c.json(denied, 401);
    if (typeof expires === 'string' && /^\d{1,16}$/.test(expires) && Number(expires) > now()) {
      return next();
    }
    const requested = c.req.method === 'GET' ? destination(c.req.path) : null;
    if (requested) return unlockForm(c, requested);
    return c.json(denied, 401);
  };

  return {
    middleware,
    close() {
      active = false;
      removeCode();
    },
  };
}
