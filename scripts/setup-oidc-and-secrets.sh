#!/usr/bin/env bash
set -euo pipefail

STEP_MESSAGES=(
  "Ensure fix/gha-oidc-ci branch and PR scaffolding"
  "Create or update GitHub OIDC provider and IAM role"
  "Detect AWS/CloudFront/S3/Vite settings (prompt if unknown)"
  "Upsert GitHub Secrets via gh CLI"
  "Trigger CI workflows, merge PR, and rerun on main"
)

log() {
  printf '[%s] %s\n' "$(date +'%Y-%m-%dT%H:%M:%S%z')" "$*" >&2
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Command '$1' is required but missing."
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

REPO_SLUG="KAVU0611/sunsetmatsue-t"
BRANCH_NAME="fix/gha-oidc-ci"
ROLE_NAME="GitHubActionsOIDC"
REGION_DEFAULT="us-east-1"
OIDC_URL="https://token.actions.githubusercontent.com"
OIDC_THUMBPRINT="6938fd4d98bab03faadb97b34396831e3780aea1"

for cmd in aws gh jq git; do
  require_cmd "$cmd"
done

log "Execution order:"
for idx in "${!STEP_MESSAGES[@]}"; do
  printf '  %s. %s\n' "$((idx + 1))" "${STEP_MESSAGES[$idx]}"
done

ensure_branch() {
  log "Ensuring branch '$BRANCH_NAME' exists locally."
  if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
    git checkout "$BRANCH_NAME" >/dev/null 2>&1 || die "Failed to checkout branch $BRANCH_NAME"
  else
    git checkout -b "$BRANCH_NAME" >/dev/null 2>&1 || die "Failed to create branch $BRANCH_NAME"
  fi

  if ! git rev-parse --abbrev-ref "${BRANCH_NAME}@{u}" >/dev/null 2>&1; then
    log "Setting upstream for $BRANCH_NAME -> origin/$BRANCH_NAME"
    git push -u origin "$BRANCH_NAME" >/dev/null 2>&1 || die "Failed to push branch $BRANCH_NAME"
  fi
}

ensure_oidc_role() {
  log "Fetching AWS account ID."
  ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
  [ -n "$ACCOUNT_ID" ] || die "Unable to determine AWS Account ID."
  PROVIDER_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"

  if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" >/dev/null 2>&1; then
    log "OIDC provider already exists: $PROVIDER_ARN"
  else
    log "Creating OIDC provider $PROVIDER_ARN"
    aws iam create-open-id-connect-provider \
      --url "$OIDC_URL" \
      --client-id-list sts.amazonaws.com \
      --thumbprint-list "$OIDC_THUMBPRINT" >/dev/null
  fi

  TRUST_POLICY="$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": "repo:${REPO_SLUG}:ref:refs/heads/main" }
    }
  }]
}
EOF
)"

  if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
    log "Updating trust policy on role $ROLE_NAME"
    aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "$TRUST_POLICY" >/dev/null
  else
    log "Creating IAM role $ROLE_NAME"
    aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "$TRUST_POLICY" >/dev/null
  fi

  log "Attaching AdministratorAccess to $ROLE_NAME (scope down later)."
  aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/AdministratorAccess >/dev/null || true

  ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)"
  [ -n "$ROLE_ARN" ] || die "Failed to obtain Role ARN."
}

prompt_if_empty() {
  local var_name="$1"
  local prompt="$2"
  local example="$3"
  local value="${!var_name:-}"
  while [ -z "$value" ]; do
    read -r -p "$prompt (e.g. $example): " value
  done
  printf -v "$var_name" '%s' "$value"
}

detect_distribution() {
  local aliased first_enabled
  aliased="$(aws cloudfront list-distributions \
    --query "DistributionList.Items[?Aliases.Items && contains(join(',',Aliases.Items),'matsuesunsetai.com')].Id | [0]" \
    --output text 2>/dev/null || true)"
  [ "$aliased" = "None" ] && aliased=""

  first_enabled="$(aws cloudfront list-distributions \
    --query "DistributionList.Items[?Enabled].Id | [0]" \
    --output text 2>/dev/null || true)"
  [ "$first_enabled" = "None" ] && first_enabled=""

  if [ -n "$aliased" ]; then
    DISTRIBUTION_ID="$aliased"
    log "Detected CloudFront distribution with matsuesunsetai.com alias: $DISTRIBUTION_ID"
  elif [ -n "$first_enabled" ]; then
    DISTRIBUTION_ID="$first_enabled"
    log "Using first enabled CloudFront distribution: $DISTRIBUTION_ID"
  fi

  if [ -z "${DISTRIBUTION_ID:-}" ]; then
    prompt_if_empty DISTRIBUTION_ID "Enter CloudFront Distribution ID" "E123456ABCDEF"
  fi
}

detect_bucket() {
  local origin domain bucket choice
  if [ -n "${DISTRIBUTION_ID:-}" ]; then
    origin="$(aws cloudfront get-distribution --id "$DISTRIBUTION_ID" \
      --query "Distribution.DistributionConfig.Origins.Items[0].DomainName" --output text 2>/dev/null || true)"
    if [ -n "$origin" ] && [ "$origin" != "None" ]; then
      domain="${origin%%/*}"
      if [[ "$domain" == *.s3.* ]]; then
        bucket="${domain%%.s3.*}"
        S3_BUCKET_NAME="$bucket"
        log "Derived S3 bucket from CloudFront origin: $S3_BUCKET_NAME"
        return
      fi
    fi
  fi

  mapfile -t bucket_candidates < <(aws s3api list-buckets --query 'Buckets[].Name' --output text 2>/dev/null | tr '\t' '\n' | grep -Ei 'sunset|site|sunsetforecaststack' || true)
  if [ "${#bucket_candidates[@]}" -eq 1 ]; then
    S3_BUCKET_NAME="${bucket_candidates[0]}"
    log "Using detected bucket: $S3_BUCKET_NAME"
  elif [ "${#bucket_candidates[@]}" -gt 1 ]; then
    log "Multiple bucket candidates detected:"
    for idx in "${!bucket_candidates[@]}"; do
      printf '  [%d] %s\n' "$((idx + 1))" "${bucket_candidates[$idx]}"
    done
    read -r -p "Select bucket number: " choice
    if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#bucket_candidates[@]}" ]; then
      S3_BUCKET_NAME="${bucket_candidates[$((choice - 1))]}"
    fi
  fi

  if [ -z "${S3_BUCKET_NAME:-}" ]; then
    prompt_if_empty S3_BUCKET_NAME "Enter S3 bucket name for frontend hosting" "sunsetforecaststack-sitebucket-xxxxx"
  fi
}

detect_vite_api_url() {
  if [ -z "${VITE_API_URL:-}" ] && [ -f frontend/.env ]; then
    VITE_API_URL="$(grep -E '^VITE_API_URL=' frontend/.env | head -n1 | cut -d= -f2-)"
  fi
  [ -n "${VITE_API_URL:-}" ] || prompt_if_empty VITE_API_URL "Enter VITE_API_URL" "https://abcdef.execute-api.us-east-1.amazonaws.com/prod"
}

ensure_secrets() {
  local repo="$1"
  log "Upserting GitHub secrets in $repo"
  gh secret set AWS_ROLE_TO_ASSUME --repo "$repo" --body "$ROLE_ARN" >/dev/null
  gh secret set AWS_REGION       --repo "$repo" --body "$REGION" >/dev/null
  gh secret set S3_BUCKET_NAME   --repo "$repo" --body "$S3_BUCKET_NAME" >/dev/null
  gh secret set DISTRIBUTION_ID  --repo "$repo" --body "$DISTRIBUTION_ID" >/dev/null
  gh secret set VITE_API_URL     --repo "$repo" --body "$VITE_API_URL" >/dev/null

  local existing
  existing="$(gh secret list --repo "$repo" --json name --jq 'map(.name)' 2>/dev/null)"
  for required in AWS_ROLE_TO_ASSUME AWS_REGION S3_BUCKET_NAME DISTRIBUTION_ID VITE_API_URL; do
    if ! echo "$existing" | jq -e --arg needle "$required" 'index($needle)' >/dev/null; then
      die "Secret $required missing after gh secret set."
    fi
  done
}

run_workflow_and_wait() {
  local workflow="$1"
  local ref="$2"
  log "Triggering workflow '$workflow' on ref '$ref'"
  gh workflow run "$workflow" --repo "$REPO_SLUG" --ref "$ref" >/dev/null
  sleep 5

  while true; do
    local run_json status conclusion branch
    run_json="$(gh run list --repo "$REPO_SLUG" --workflow "$workflow" --branch "$ref" --limit 1 --json status,conclusion,headBranch 2>/dev/null)"
    if [ -z "$run_json" ] || [ "$run_json" = "[]" ]; then
      sleep 5
      continue
    fi
    status="$(echo "$run_json" | jq -r '.[0].status')"
    conclusion="$(echo "$run_json" | jq -r '.[0].conclusion')"
    branch="$(echo "$run_json" | jq -r '.[0].headBranch')"
    [ "$branch" = "$ref" ] || { sleep 5; continue; }

    if [ "$status" = "completed" ]; then
      if [ "$conclusion" = "success" ]; then
        log "Workflow '$workflow' on '$ref' succeeded."
        break
      fi
      die "Workflow '$workflow' on '$ref' failed with conclusion=$conclusion"
    fi
    sleep 10
  done
}

trigger_pr_and_ci() {
  log "Ensuring PR exists for $BRANCH_NAME"
  if ! gh pr view --repo "$REPO_SLUG" --head "$BRANCH_NAME" >/dev/null 2>&1; then
    gh pr create \
      --repo "$REPO_SLUG" \
      --base main \
      --head "$BRANCH_NAME" \
      --title "fix: GitHub Actions OIDC + required secrets guard" \
      --body "Enable OIDC role, set required secrets guard, and stabilize CDK/Frontend deploy." >/dev/null
    log "Created PR for $BRANCH_NAME"
  fi

  local pr_json pr_number
  pr_json="$(gh pr view --repo "$REPO_SLUG" --head "$BRANCH_NAME" --json number,url,headRefName,mergeStateStatus)"
  pr_number="$(echo "$pr_json" | jq -r '.number')"
  log "PR $(echo "$pr_json" | jq -r '.url') (head=$(echo "$pr_json" | jq -r '.headRefName')) state=$(echo "$pr_json" | jq -r '.mergeStateStatus')"

  run_workflow_and_wait "CDK Deploy" "$BRANCH_NAME"
  run_workflow_and_wait "Frontend Build & Deploy" "$BRANCH_NAME"

  log "Attempting to enable auto-merge (squash)."
  if ! gh pr merge "$pr_number" --repo "$REPO_SLUG" --squash --auto >/dev/null 2>&1; then
    die "gh pr merge failed. Ensure reviews are approved, then rerun."
  fi

  log "Waiting for PR to close."
  while true; do
    local state
    state="$(gh pr view "$pr_number" --repo "$REPO_SLUG" --json state --jq '.state' 2>/dev/null || echo CLOSED)"
    if [ "$state" != "OPEN" ]; then
      break
    fi
    sleep 10
  done

  log "PR merged. Re-running workflows on main."
  run_workflow_and_wait "CDK Deploy" "main"
  run_workflow_and_wait "Frontend Build & Deploy" "main"
}

print_summary() {
  git fetch origin main >/dev/null 2>&1 || true
  local latest_main
  latest_main="$(git rev-parse origin/main 2>/dev/null || echo 'unknown')"

  cat <<EOF

==== Summary ====
ROLE_ARN:        $ROLE_ARN
REGION:          $REGION
DISTRIBUTION_ID: $DISTRIBUTION_ID
S3_BUCKET_NAME:  $S3_BUCKET_NAME
VITE_API_URL:    $VITE_API_URL
main@origin:     $latest_main

If workflows fail later, inspect GitHub Actions logs for:
  - Guard required secrets
  - aws sts get-caller-identity
  - npm ci / npm run build
  - aws s3 sync / aws s3 cp
  - aws cloudfront create-invalidation
  - npx cdk deploy
EOF
}

main() {
  REGION="${AWS_REGION:-$REGION_DEFAULT}"
  ensure_branch
  ensure_oidc_role
  detect_distribution
  detect_bucket
  detect_vite_api_url
  ensure_secrets "$REPO_SLUG"
  trigger_pr_and_ci
  print_summary
}

main "$@"
