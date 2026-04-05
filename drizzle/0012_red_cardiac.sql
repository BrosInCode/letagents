ALTER TABLE "tasks" ADD COLUMN "workflow_artifacts" jsonb DEFAULT '[]'::jsonb NOT NULL;

UPDATE "tasks"
SET "workflow_artifacts" = jsonb_build_array(
  jsonb_strip_nulls(
    jsonb_build_object(
      'provider',
      CASE
        WHEN "pr_url" ~ '^https://github\.com/[^/]+/[^/]+/pull/[0-9]+/?$' THEN 'github'
        WHEN "pr_url" ~ '^https://gitlab\.com/.+/-/merge_requests/[0-9]+/?$' THEN 'gitlab'
        WHEN "pr_url" ~ '^https://bitbucket\.org/[^/]+/[^/]+/pull-requests/[0-9]+/?$' THEN 'bitbucket'
        ELSE 'unknown'
      END,
      'kind',
      CASE
        WHEN "pr_url" ~ '^https://gitlab\.com/.+/-/merge_requests/[0-9]+/?$' THEN 'merge_request'
        ELSE 'pull_request'
      END,
      'number',
      CASE
        WHEN "pr_url" ~ '^https://github\.com/[^/]+/[^/]+/pull/[0-9]+/?$'
          THEN ((regexp_match("pr_url", '/pull/([0-9]+)'))[1])::integer
        WHEN "pr_url" ~ '^https://gitlab\.com/.+/-/merge_requests/[0-9]+/?$'
          THEN ((regexp_match("pr_url", '/-/merge_requests/([0-9]+)'))[1])::integer
        WHEN "pr_url" ~ '^https://bitbucket\.org/[^/]+/[^/]+/pull-requests/[0-9]+/?$'
          THEN ((regexp_match("pr_url", '/pull-requests/([0-9]+)'))[1])::integer
        ELSE NULL
      END,
      'url',
      "pr_url"
    )
  )
)
WHERE "pr_url" IS NOT NULL
  AND "pr_url" <> ''
  AND "workflow_artifacts" = '[]'::jsonb;
