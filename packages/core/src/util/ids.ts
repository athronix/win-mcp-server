import { randomBytes } from 'node:crypto';

function rand(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export function newTraceId(): string {
  return `tr_${rand(8)}`;
}

export function newApprovalId(): string {
  return `apr_${rand(10)}`;
}

export function newActionId(): string {
  return `act_${rand(8)}`;
}