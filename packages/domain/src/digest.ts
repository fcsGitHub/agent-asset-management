// 摘要与规范化（设计 13 章）：candidate_digest / review_digest。
// 规范化规则固定：递归键排序（stableStringify），sha256。
import { createHash } from "node:crypto";

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export const POLICY_VERSION = "review-policy/v1";

export interface ReviewDigestInput {
  candidateDigest: string;
  evidenceDigests: string[];
  releaseNotes: Record<string, unknown>;
  policyVersion: string;
  channel: string;
  audience: string;
}

export function reviewDigest(input: ReviewDigestInput): string {
  return canonicalDigest({
    candidate_digest: input.candidateDigest,
    evidence_digests: [...input.evidenceDigests].sort(),
    release_notes: input.releaseNotes,
    policy_version: input.policyVersion,
    channel: input.channel,
    audience: input.audience,
  });
}
