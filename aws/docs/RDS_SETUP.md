# Sakhi Sahayak — RDS PostgreSQL and Render Runtime Setup

**Current observed AWS database inventory (2026-11-08):** no RDS DB instances or DB clusters exist in account `758371668629`, region `ap-south-1`. The Terraform below is configuration only; it does not mean a database has been created.

## Architecture

- Vercel hosts the Vite frontend.
- Render runs the Node 24 / Express / Socket.IO backend in Singapore.
- Amazon RDS for PostgreSQL is in AWS Mumbai (`ap-south-1`).
- S3 stores evidence objects in the existing private bucket.
- GitHub Actions uses the existing GitHub OIDC role to publish immutable ECR images.
- Render uses its own workload OIDC role at runtime for narrowly scoped S3 object access.

Render Singapore and AWS Mumbai are not a same-region private-network pairing. The optional RDS instance is therefore configured with a public endpoint, TLS-required clients, and a security group that accepts TCP/5432 only from explicit, verified Render outbound CIDRs. Never use `0.0.0.0/0`.

## Cost and opt-in controls

The infrastructure is intentionally **disabled by default**:

- `enable_rds = false`
- `enable_render_oidc = false`
- `render_outbound_cidrs = []`

This preserves the existing low-cost AWS footprint. Do not turn these on unless the owner accepts the recurring spend.

Indicative planning estimate (USD/month, before taxes, usage overages, backup/storage growth, data transfer, and other app services):

| Component | Estimate |
|---|---:|
| RDS `db.t4g.micro` single-AZ compute | ~$15.33 |
| 20 GiB gp3 storage | ~$2.62 |
| Public IPv4 for internet-reachable RDS | ~$3.65 |
| RDS-managed Secrets Manager master secret | ~$0.40 |
| **AWS RDS subtotal** | **~$22.00+** |
| Render Pro workspace (needed for AWS OIDC) | $25 |
| Render Starter web service | ~$7 |
| **Hybrid baseline** | **~$54+/month** |

A Render dedicated outbound IP set costs an additional $100/month per set. That is not included and should not be purchased automatically. Pricing can change; use AWS Pricing Calculator and Render's current pricing page before activation. AWS credits do not pay Render invoices.

Official pricing references:
- https://aws.amazon.com/rds/postgresql/pricing/
- https://aws.amazon.com/vpc/pricing/
- https://aws.amazon.com/secrets-manager/pricing/
- https://render.com/pricing
- https://render.com/docs/oidc

This is incompatible with the previous <$2/month AWS target. For that budget, leave RDS and Render OIDC disabled and keep this project at CI/ECR + existing S3, or choose a separately budgeted managed database.

## Step 1 — Render CLI inventory

In WSL:

```bash
render login
render workspaces
render services
```

From the Render Dashboard / service details, collect:
- Workspace ID (`tea-...`)
- Environment ID (`evm-...`), or `default` if the service is not in a Render environment
- Backend service ID (`srv-...`)
- The service's outbound IP ranges (CIDRs) for the region where it runs

Do not paste API keys or database passwords into chat or GitHub. The exact CIDRs and IDs are required before an RDS / OIDC plan can be enabled.

Render AWS OIDC requires a Pro workspace or higher. It issues rotating, short-lived credentials; the service needs only `AWS_ROLE_ARN`. Render automatically supplies `AWS_WEB_IDENTITY_TOKEN_FILE`; do not set that variable yourself. OIDC does not replace the separate ECR registry credential used to pull the private image.

## Step 2 — Protect the existing Terraform state

The Terraform root uses **local state**. The state files are intentionally excluded from Git. Run these commands only in the original WSL checkout that contains the imported state:

```bash
cd aws/terraform
test -f terraform.tfstate
cp terraform.tfstate "terraform.tfstate.backup.$(date +%Y%m%d-%H%M%S)"
terraform state list
```

Confirm the existing 22 imported resource addresses are present before planning. Do not run `terraform init -migrate-state`, delete state, re-import the 22 resources, or run Terraform from a fresh clone without the original state. Do not commit `terraform.tfstate`, `*.tfvars`, or plans.

The PR CI performs only `terraform fmt` / `terraform validate` using `terraform init -backend=false`; it does not access AWS or the user's state file.

## Step 3 — Collect safe inputs before planning

Create or edit local `terraform.tfvars` (ignored by Git). Keep the opt-in flags false until the account, budget, Render region, IDs, and CIDRs have been reviewed:

```hcl
enable_rds            = false
enable_render_oidc    = false
render_outbound_cidrs = []

# Fill only after Render inventory and Pro OIDC eligibility are confirmed:
# render_workspace_id   = "tea-..."
# render_environment_id = "evm-..." # or "default"
# render_service_id     = "srv-..."
# render_outbound_cidrs = ["<verified IPv4 CIDR>", "..."]
```

The RDS configuration creates a subnet group, security group, and encrypted single-AZ PostgreSQL instance. RDS manages the master password in Secrets Manager; Terraform does not accept a plaintext DB password. The database has deletion protection, a final-snapshot requirement, and Terraform `prevent_destroy`.

Only after cost approval and after verified CIDRs/IDs are known should you set the relevant flags true and run:

```bash
terraform fmt -check -recursive
terraform validate
terraform plan -out=tfplan
```

Read the complete plan. It should show only the intended additions (3 for RDS; 3 for Render OIDC) and **zero changes or destroys** to the 22 existing resources. Stop if Terraform proposes changing or destroying any existing resource. Do not apply until the final plan and monthly cost are deliberately approved.

## Step 4 — Bootstrap least-privilege database users

RDS stores the administrative credential in its generated Secrets Manager secret. Retrieve it locally using AWS CLI and do not disclose it:

```bash
aws secretsmanager get-secret-value --secret-id "<rds_master_secret_arn>" --query SecretString --output text
```

Install `psql` in WSL if needed:

```bash
sudo apt update
sudo apt install postgresql-client
```

Connect using the master secret and create two separate accounts. Generate passwords locally with `openssl rand -hex 32`; replace the placeholders locally, not in source control:

```sql
-- Run as the RDS master user while connected to sakhi_production:
CREATE USER sakhi_migrator WITH PASSWORD '<MIGRATION_PASSWORD>';
CREATE USER sakhi_app WITH PASSWORD '<APP_PASSWORD>';

GRANT CONNECT ON DATABASE sakhi_production TO sakhi_migrator, sakhi_app;
GRANT USAGE ON SCHEMA public TO sakhi_app;
GRANT CREATE ON SCHEMA public TO sakhi_migrator;

-- Existing objects, if any:
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sakhi_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sakhi_app;

-- Reconnect to sakhi_production as sakhi_migrator, then run these defaults.
-- They make future Prisma-created tables/sequences available to sakhi_app.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sakhi_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO sakhi_app;
```

The runtime account cannot create or alter tables. The migration account owns objects it creates and can apply Prisma schema migrations. `sakhi_migrator` must own or be allowed to alter the objects created by Prisma migrations. `sakhi_app` receives no schema `CREATE`, `ALTER`, or `DROP` permission. Keep both passwords in Render's encrypted environment settings only.

## Step 5 — Configure Render environment

Set these in the backend service's environment:

```dotenv
NODE_ENV=production
AWS_REGION=ap-south-1
S3_EVIDENCE_BUCKET=sakhi-evidence-758371668629
AWS_ROLE_ARN=<iam_role_render_workload_arn>
DATABASE_URL=postgresql://sakhi_app:<APP_PASSWORD>@<RDS_ENDPOINT>:5432/sakhi_production?schema=public&sslmode=require
DIRECT_URL=postgresql://sakhi_migrator:<MIGRATION_PASSWORD>@<RDS_ENDPOINT>:5432/sakhi_production?schema=public&sslmode=require
JWT_SECRET=<random-32-byte-or-stronger-secret>
```

Also set the required AI, notification, CORS, and frontend-origin variables from the existing `Server/.env.example` and deployment runbook. Do not set static AWS access keys and do not set `AWS_WEB_IDENTITY_TOKEN_FILE`.

The Docker image now runs `prisma migrate deploy` before starting the Node process. If database configuration or migration fails, the container will not start serving requests. The GitHub Actions deployment workflow verifies both:
- `/health` — process liveness
- `/ready` — successful PostgreSQL connection

## Step 6 — Verify after deployment

From your terminal:

```bash
curl -fsS "$RENDER_SERVICE_URL/health"
curl -fsS "$RENDER_SERVICE_URL/ready"
```

The readiness response must report `"status":"ready"` and `"database":"connected"`. Confirm a user can register, log in, and persist across a redeploy; confirm evidence uploads reach the private S3 bucket and metadata appears in PostgreSQL. Do not call the service production-ready based on `/health` alone.

## Rollback / shutdown safety

- Apply corrective database migrations forward; do not roll back applied Prisma migrations by editing migration history.
- Roll back the application image by immutable ECR digest if a release fails.
- RDS deletion is deliberately blocked by deletion protection and Terraform `prevent_destroy`. Any intentional retirement requires a reviewed backup/export and a separate explicit teardown procedure.
