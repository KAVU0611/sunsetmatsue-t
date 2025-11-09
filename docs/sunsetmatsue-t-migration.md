# Sunsetmatsue-t Migration Guide

The `sunsetmatsue-t` repository is a clean clone of the code currently deployed to `https://matsuesunsetai.com/`. Use the steps below to publish it to GitHub and re-wire GitHub Actions to assume the correct IAM role via OIDC.

## 1. Create the GitHub repository

```bash
gh repo create KAVU0611/sunsetmatsue-t --private --description "Production code for matsuesunsetai.com"
```

(If you prefer the web UI, create the repo there, then rerun the remaining commands.)

## 2. Push `main`

```bash
cd sunsetmatsue-t
git remote -v        # should already point to https://github.com/KAVU0611/sunsetmatsue-t.git
git push -u origin main
```

## 3. Update the IAM trust policy

The IAM role used in CI must now trust the new repository. You can reuse `docs/oidc-trust-policy.json` as a template—note that it already contains the `repo:KAVU0611/sunsetmatsue-t:ref:refs/heads/main` subject. Apply it with:

```bash
aws iam update-assume-role-policy \
  --role-name GitHubActionsOIDC \
  --policy-document file://docs/oidc-trust-policy.json
```

## 4. Re-seed GitHub Secrets

Run the helper script to fill in `AWS_ROLE_TO_ASSUME`, `AWS_REGION`, `S3_BUCKET_NAME`, `DISTRIBUTION_ID`, and `VITE_API_URL` for the new repo:

```bash
cd sunsetmatsue-t
./scripts/setup-oidc-and-secrets.sh
```

This script creates/updates the `fix/gha-oidc-ci` branch, ensures the correct IAM role + trust policy, and triggers the `CDK Deploy` / `Frontend Build & Deploy` workflows on the freshly created repository.

## 5. Verify Actions

Push a trivial change to `main` (for example, touch `README.md`) and confirm that:

1. `Frontend Build & Deploy / build-and-deploy` reaches the assume-role step successfully.
2. `CDK Deploy / deploy` also passes the `aws-actions/configure-aws-credentials@v4` phase.

If either workflow still reports `Not authorized to perform sts:AssumeRoleWithWebIdentity`, double-check that the IAM trust policy references `sunsetmatsue-t` (not the previous repository).
