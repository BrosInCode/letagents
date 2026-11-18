// Git: open pull requests, checks and reviews for the room's repository.
// Everything here comes from GitHub webhooks LetAgents has stored; no read
// calls GitHub, so a state is as fresh as the last event GitHub sent.
import { z } from "zod";

import { defineMethod } from "./core.mjs";

/** Check runs by outcome; a run still going or with an unknown outcome is `pending`. */
export const CheckSummary = z.object({
  total: z.number().int().nonnegative(),
  success: z.number().int().nonnegative(),
  failure: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
});

/** Reviewers by their latest decisive review. */
export const ReviewSummary = z.object({
  total: z.number().int().nonnegative(),
  approved: z.number().int().nonnegative(),
  changesRequested: z.number().int().nonnegative(),
});

/**
 * A pull request linked to a task or a release. The state and summaries are
 * null when LetAgents has no GitHub event for it, only the link.
 */
export const PullRequestLink = z.object({
  url: z.string(),
  number: z.number().int().nullable(),
  title: z.string().nullable(),
  /** `open`, `closed` or `merged`. */
  state: z.string().nullable(),
  draft: z.boolean().nullable(),
  checks: CheckSummary.nullable(),
  reviews: ReviewSummary.nullable(),
});

export const CheckRun = z.object({
  name: z.string(),
  /** `queued`, `in_progress` or `completed`. */
  status: z.string().nullable(),
  /** `success`, `failure`, `neutral`, `skipped`, `cancelled`, `timed_out`, `action_required`; null while running. */
  conclusion: z.string().nullable(),
  url: z.string().nullable(),
});

export const Review = z.object({
  login: z.string(),
  /** `approved`, `changes_requested`, `commented` or `dismissed`. */
  state: z.string(),
});

export const OpenPullRequest = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  author: z.string().nullable(),
  draft: z.boolean(),
  headRef: z.string().nullable(),
  baseRef: z.string().nullable(),
  /** When GitHub last changed it, as far as LetAgents has heard. */
  updatedAt: z.string(),
  checks: CheckSummary,
  /** The latest run of each check on the pull request's head commit. */
  checkRuns: z.array(CheckRun),
  reviews: ReviewSummary,
  reviewers: z.array(Review),
  /** People and teams asked to review who have not reviewed since. */
  requestedReviewers: z.array(z.string()),
  /** Board tasks in this room that link this pull request. */
  taskIds: z.array(z.string()),
});

export const PullRequestList = z.object({
  /** `owner/name`; null when the room follows no repository. */
  repo: z.string().nullable(),
  /** Most recently updated first. */
  pullRequests: z.array(OpenPullRequest),
  /** True when there are more open pull requests than the list holds. */
  truncated: z.boolean(),
});

/** @typedef {z.infer<typeof CheckSummary>} CheckSummary */
/** @typedef {z.infer<typeof ReviewSummary>} ReviewSummary */
/** @typedef {z.infer<typeof PullRequestLink>} PullRequestLink */
/** @typedef {z.infer<typeof CheckRun>} CheckRun */
/** @typedef {z.infer<typeof Review>} Review */
/** @typedef {z.infer<typeof OpenPullRequest>} OpenPullRequest */
/** @typedef {z.infer<typeof PullRequestList>} PullRequestList */

export const listPullRequests = defineMethod({
  name: "git.pullRequests",
  area: "git",
  kind: "read",
  capability: "git.read",
  description:
    "Open pull requests of the room's repository, most recently updated first (up to 100), with their check runs, reviews, requested reviewers and linked board tasks. Built from the GitHub events LetAgents has received, not a live GitHub read. A room without a repository gets an empty list.",
  path: "/rooms/:room/git/pull-requests",
  input: z.strictObject({}),
  output: PullRequestList,
  rateClass: "read",
});

export const methods = /** @type {const} */ ([listPullRequests]);
