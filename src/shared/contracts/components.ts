import { AccountReport } from './accounts.ts';
import {
  DeliveryCoverage,
  LinkClass,
  Provider,
  Scope,
  TokenCount,
  UsageCoverage,
} from './common.ts';
import { ErrorEnvelope } from './errors.ts';
import {
  ClaudeHooksFile,
  ClaudeHooksPlan,
  ClaudeHooksStatus,
  HqAgent,
  HqFeed,
  HqResponse,
} from './hq.ts';
import {
  WorkReviewEvidence,
  WorkReviewVersion,
  WorkReviewState,
  WorkReviewBullet,
  WorkReviewAccount,
  WorkReviewAutomation,
} from './work-review.ts';
import { LinkHealth } from './link-health.ts';
import { PaseoQuotaResponse } from './paseo-quota.ts';
import { EvidenceItem, PullRequest } from './prs.ts';
import { Repo } from './repos.ts';
import { Bucket } from './series.ts';
import { AccountStatus, RefreshRun, SourceStatus } from './sources.ts';
import { ModelShare, ProviderKpi, Session } from './usage.ts';

/**
 * The named schemas of docs/tech/local-api.md (`components.schemas`, plus ProviderKpi and ModelShare from the block
 * after it), by their documented name. The contract test checks each one against the document.
 */
export const COMPONENTS = {
  WorkReviewEvidence,
  WorkReviewVersion,
  WorkReviewState,
  WorkReviewBullet,
  WorkReviewAccount,
  WorkReviewAutomation,
  ErrorEnvelope,
  Provider,
  Scope,
  UsageCoverage,
  DeliveryCoverage,
  TokenCount,
  Bucket,
  SourceStatus,
  AccountStatus,
  AccountReport,
  Session,
  LinkClass,
  LinkHealth,
  PullRequest,
  EvidenceItem,
  Repo,
  RefreshRun,
  HqAgent,
  HqFeed,
  HqResponse,
  PaseoQuotaResponse,
  ClaudeHooksStatus,
  ClaudeHooksFile,
  ClaudeHooksPlan,
  ProviderKpi,
  ModelShare,
} as const;
