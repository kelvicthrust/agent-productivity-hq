import { createHmac, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { dirname, join } from 'node:path';

const controlFile = (dataDir) => join(dataDir, 'agent-productivity-cli.json');

// A control record copied with the database cannot authenticate for the original data directory.
export async function controlToken(dataDir, secret) {
  return createHmac('sha256', secret)
    .update(await realpath(dataDir))
    .digest('hex');
}

export async function readControl(dataDir) {
  try {
    const path = controlFile(dataDir);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) return null;
    const control = JSON.parse(await readFile(path, 'utf8'));
    if (
      typeof control.path !== 'string' ||
      !/^\/tmp\/agent-productivity-[a-z\d]{6}\/control\.sock$/i.test(control.path) ||
      typeof control.secret !== 'string' ||
      !/^[a-f0-9]{64}$/.test(control.secret)
    ) {
      return null;
    }
    const folder = await lstat(dirname(control.path));
    const socket = await lstat(control.path);
    if (
      folder.isDirectory() &&
      folder.uid === process.getuid() &&
      (folder.mode & 0o077) === 0 &&
      socket.isSocket() &&
      socket.uid === process.getuid()
    ) {
      return { path: control.path, token: await controlToken(dataDir, control.secret) };
    }
  } catch {
    // Before first launch or after a stopped instance, there is no control socket.
  }
  return null;
}

export async function publishControl(dataDir, control) {
  const path = controlFile(dataDir);
  const temporary = `${path}.${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(control)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function removeControl(dataDir) {
  await rm(controlFile(dataDir), { force: true });
}

export async function contactControl(control, stop = false) {
  if (!control) return null;
  return new Promise((resolve) => {
    const action = request(
      {
        socketPath: control.path,
        method: stop ? 'POST' : 'GET',
        path: '/',
        headers: { authorization: `Bearer ${control.token}` },
        signal: AbortSignal.timeout(stop ? 7000 : 1000),
      },
      (response) => {
        if (stop || response.statusCode !== 200) {
          response.resume();
          resolve(stop ? response.statusCode === 204 : null);
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('error', () => resolve(null));
        response.on('close', () => resolve(null));
        response.on('data', (chunk) => {
          body += chunk;
          if (body.length > 128) action.destroy();
        });
        response.on('end', () => {
          const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(body);
          resolve(match && Number(match[1]) <= 65535 ? body : null);
        });
      },
    );
    action.on('error', () => resolve(null));
    action.end();
  });
}
