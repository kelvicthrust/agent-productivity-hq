export type WorkReviewWorkerErrorCode =
  | 'unavailable'
  | 'cancelled'
  | 'timeout'
  | 'invalid_input'
  | 'invalid_output'
  | 'sign_in_required'
  | 'model_unavailable'
  | 'not_eligible'
  | 'usage_limit'
  | 'unsupported';

export class WorkReviewWorkerError extends Error {
  readonly code: WorkReviewWorkerErrorCode;

  constructor(code: WorkReviewWorkerErrorCode) {
    super(code);
    this.name = 'WorkReviewWorkerError';
    this.code = code;
  }
}
