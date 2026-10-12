/** Required labels for AI implement + AI review workflows (GitHub and GitLab). */
export const AI_WORKER_LABELS = [
  {
    name: 'ai',
    color: '0E8A16',
    description: 'Queue this issue for the AI worker',
  },
  {
    name: 'ai-working',
    color: 'FBCA04',
    description: 'AI worker is currently processing this issue',
  },
  {
    name: 'ai-pr',
    color: '1D76DB',
    description: 'AI worker completed the issue and created a pull request',
  },
  {
    name: 'ai-failed',
    color: 'D73A4A',
    description: 'AI worker failed; review logs before retrying',
  },
  {
    name: 'ai-review',
    color: '7057FF',
    description: 'Queue this open pull request for an AI review comment',
  },
  {
    name: 'ai-reviewing',
    color: 'FBCA04',
    description: 'AI worker is currently reviewing this pull request',
  },
  {
    name: 'ai-reviewed',
    color: '0E8A16',
    description: 'AI review comment was posted on this pull request',
  },
  {
    name: 'ai-review-failed',
    color: 'D73A4A',
    description: 'AI PR review failed; review logs before retrying',
  },
] as const

export type AiWorkerLabel = (typeof AI_WORKER_LABELS)[number]
