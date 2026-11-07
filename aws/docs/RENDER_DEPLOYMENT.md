# Sakhi Sahayak — Render + ECR Deployment Guide

## Deployment topology

- GitHub Actions verifies every pull request and every push to `main`.
- The main-branch workflow builds a Linux AMD64 backend image and pushes a SHA-tagged image to Amazon ECR.
- The workflow captures the immutable ECR digest, refreshes Render's AWS ECR registry credential using a short-lived ECR token, and asks Render to deploy that exact digest.
- A live Render deployment is polled through the Render API and then checked through `GET /health`.
- The Vercel frontend is connected to the same GitHub repository and uses Vite environment variables to call Render.
- No ECS service, Fargate task, ALB, NAT Gateway, RDS, or DocumentDB is created by these workflows.

## Render backend service — one-time setup

Create an **image-backed Web Service** in the Render Dashboard. Do not choose a Git-backed service for this workflow.

1. Choose **Existing Image**.
2. Set the image to:
   `758371668629.dkr.ecr.ap-south-1.amazonaws.com/sakhi-server:latest`
3. Add an AWS ECR registry credential:
   - Registry: AWS ECR
   - Username: `758371668629`
   - Password: output of `aws ecr get-login-password --region ap-south-1`
   - This password expires after 12 hours. The automation below refreshes it.
4. Use a region near the application's users (Singapore is a reasonable latency choice where available).
5. Configure the service as a Web Service, with its container port set to `5001` if the dashboard asks for it.
6. Set the Render health-check path to `/health`.
7. Disable any separate automatic Git deployment. The workflow controls deployments using the ECR digest.
8. Complete the initial deployment once, then record:
   - Render service ID
   - Registry credential ID
   - Public Render service URL

The initial manual setup is required because this project does not yet have a Render service ID or registry credential ID in its source configuration. The workflow will not create paid Render resources.

## GitHub Actions configuration

Add these **repository secrets** under Settings → Secrets and variables → Actions → Secrets:

| Secret | Value |
|---|---|
| `RENDER_API_KEY` | Render API key |
| `RENDER_SERVICE_ID` | ID of the image-backed Render Web Service |
| `RENDER_REGISTRY_CREDENTIAL_ID` | ID of the AWS ECR registry credential in Render |

Add these **repository variables** under Settings → Secrets and variables → Actions → Variables:

| Variable | Value |
|---|---|
| `RENDER_SERVICE_URL` | Public service origin, e.g. `https://your-service.onrender.com` (no trailing slash) |
| `RENDER_DEPLOY_ENABLED` | Set to `true` only after the image-backed service, registry credential, and secrets are configured |

Until `RENDER_DEPLOY_ENABLED=true`, CI and ECR publishing still run but the Render deploy and credential-refresh jobs are skipped.

Do not commit API keys, deploy hooks, ECR passwords, or application secrets. Do not paste credentials into chat or workflow files.

The workflow uses the existing GitHub OIDC role `GitHubActionsSakhiRole`. It obtains a fresh ECR password at runtime; no long-lived AWS access keys are stored in GitHub.

## Automated backend CI/CD

On pull requests to `main`, the workflow:
- Installs backend dependencies and runs all Node test files.
- Builds the Vite frontend.
- Builds the backend Docker image for `linux/amd64`.
- Checks that Docker health-check metadata exists.
- Does not authenticate to AWS, publish to ECR, or deploy.

On pushes to `main` (and manual workflow dispatch from `main`), it:
- Completes the same validation.
- Pushes both the commit SHA tag and `latest` to ECR.
- Captures the pushed image digest.
- Refreshes the Render registry credential.
- Triggers Render with `imageUrl = ECR_URI@sha256:DIGEST`.
- Waits for Render status `live`.
- Polls the public `/health` endpoint.

The immutable digest—not `latest`—is the deployed release identifier.

## ECR credential lifetime and scheduled refresh

AWS ECR authorization passwords expire after 12 hours. Render's documentation says a private ECR credential must be refreshed and that services using an updated credential must be redeployed to use the updated values.

The separate `refresh-render-ecr-credential.yml` workflow runs every six hours without a manual production approval. It:
1. Finds the most recent live Render image digest.
2. Gets a fresh ECR password through GitHub OIDC.
3. Updates the Render registry credential.
4. Re-deploys the same immutable image digest.
5. Waits for the deployment and verifies `/health`.

This deliberately re-deploys the backend every six hours to apply the refreshed ECR credential. It does not create AWS compute, but Render service usage/availability is separate from the AWS budget. Review whether this redeploy cadence is acceptable for the selected Render plan.

## Vercel frontend setup

Connect the same repository to Vercel and set the project Root Directory to:

`women-safety-webApp/Client`

Build settings:
- Framework: Vite
- Install command: `npm ci`
- Build command: `npm run build`
- Output directory: `dist`

Set these Vercel Production and Preview environment variables to the actual Render service origin:

```dotenv
VITE_API_BASE_URL=https://your-service.onrender.com/api
VITE_SOCKET_URL=https://your-service.onrender.com
```

The React REST API calls and Socket.IO connections now use these variables. Local development falls back to `http://localhost:5001`.

Vercel's Git integration can deploy the frontend on pushes independently of the backend workflow. The workflow validates the frontend build but does not use a Vercel API token or claim to have performed a Vercel deployment.

## Manual Render rollback

Use GitHub Actions → **Sakhi Sahayak - Roll Back Render Backend** → Run workflow.

Supply the ID of the previous known-good Render deploy. The workflow calls Render's rollback endpoint, waits until it is live, and verifies `/health`.

Keep the prior image digest available in ECR. Deleting its image would prevent a digest-based redeploy or rollback.

## Production data and storage caveats — resolve before relying on this service

The backend currently calls Mongoose with `MONGO_URI`. When that variable is absent or the database cannot be reached, the code falls back to in-memory demo data. In-memory users are not durable across process restarts or redeployments.

The evidence recorder uses local disk when S3 is not configured. Render's container filesystem is ephemeral unless a persistent disk is configured. Evidence written only to local disk can be lost during redeploys/restarts.

The current S3 client uses the AWS SDK default credential chain. An ECS task role does not automatically become available to a Render service. Do not set `S3_EVIDENCE_BUCKET` on Render until a secure workload-identity or other approved credential design is configured. Do not copy long-lived AWS access keys into source code.

Therefore, a successful `/health` check verifies that the HTTP process is alive; it does not prove database persistence, S3 evidence durability, emergency-notification provider credentials, or complete application readiness.

## AWS budget guardrails

These workflows use the existing ECR repository and GitHub OIDC role. They do not create ECS services/tasks, EC2 instances, load balancers, NAT gateways, database instances, VPC endpoints, or additional AWS infrastructure.

ECR image storage and requests can still incur charges. AWS budget alerts are not hard spending caps. Keep an eye on ECR storage and the monthly bill.

## Official Render references

- Deploy a prebuilt image / AWS ECR credentials: https://render.com/docs/deploying-an-image
- Deploy hooks and image digest deployment: https://render.com/docs/deploy-hooks
- Update registry credential: https://api-docs.render.com/reference/update-registry-credential
- Trigger deploy: https://api-docs.render.com/reference/create-deploy
- Retrieve deploy: https://api-docs.render.com/reference/retrieve-deploy
- Roll back deploy: https://api-docs.render.com/reference/rollback-deploy
