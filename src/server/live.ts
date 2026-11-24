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
  const github = createLiveGithub();
  return {
    workReview: {
      keyring: github.keyring,
      authNet: createNet({ scope: 'work-review-auth' }),
      modelNet: createNet({ scope: 'work-review', timeoutMs: 60_000 }),
    },
    local: { env, home },
    github,
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
