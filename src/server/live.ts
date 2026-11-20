import { homedir } from 'node:os';
import type { BootDeps } from './boot.ts';
import { createLiveLauncher } from './collectors/chatgpt/live.ts';
import { createLiveGithub } from './collectors/github/live.ts';
import { createClaudePlanCredentialReader } from './integrations/claudePlan/credentials.ts';
import { createNet } from './lib/net.ts';

/** The same live sources and account tools for local and Paseo-managed startup. */
export function liveBootDeps(): BootDeps {
  const home = homedir();
  const env = process.env;
  return {
    local: { env, home },
    github: createLiveGithub(),
    paseo: {},
    chatgpt: { launch: createLiveLauncher() },
    claude: {
      env,
      home,
      planLimits: {
        readCredential: createClaudePlanCredentialReader(),
        net: createNet({ scope: 'claude-plan' }),
      },
    },
  };
}
