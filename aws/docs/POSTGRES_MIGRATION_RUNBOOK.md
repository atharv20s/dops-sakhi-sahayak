# Sakhi Sahayak — PostgreSQL Migration, Networking & Operational Runbook

**Feature Branch**: `feat/postgres-prisma-migration`
**Target Architecture**: Hybrid (Render Backend in Singapore + AWS RDS PostgreSQL in Mumbai + AWS S3 Evidence Storage + Vercel React Frontend)
**Strict Safety Rule**: No AWS or Render resources are provisioned without explicit review and approval.

---

## 1. Corrected Render → AWS OIDC Architecture

Render's native AWS Workload Identity (OIDC) eliminates the need for static AWS IAM access keys in Render environment variables.

### 1.1 OIDC Identity Provider Details
- **Issuer URL**: `https://oidc.render.com/<WORKSPACE_ID>` (where `<WORKSPACE_ID>` is your Render workspace identifier)
- **Audience**: `sts.amazonaws.com`
- **Thumbprint**: Obtained via Render's OIDC certificate authority or AWS automated thumbprint validation.

### 1.2 Scoped AWS IAM Trust Policy (`RenderWorkloadRole`)
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::758371668629:oidc-provider/oidc.render.com/<WORKSPACE_ID>"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "oidc.render.com/<WORKSPACE_ID>:aud": "sts.amazonaws.com",
          "oidc.render.com/<WORKSPACE_ID>:sub": "workspace:<WORKSPACE_ID>:environment:<ENVIRONMENT_ID>:service:<RENDER_SERVICE_ID>"
        }
      }
    }
  ]
}
```

### 1.3 Least-Privilege S3 Evidence Policy (`RenderS3EvidencePolicy`)
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowS3EvidenceAccess",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject"
      ],
      "Resource": "arn:aws:s3:::sakhi-evidence-758371668629/evidence/*"
    }
  ]
}
```

### 1.4 Render Environment Configuration
When Workload Identity is enabled, Render automatically injects `AWS_WEB_IDENTITY_TOKEN_FILE`. Configure the following in the Render Dashboard:
- `AWS_ROLE_ARN`: `arn:aws:iam::758371668629:role/RenderSakhiWorkloadRole`
- `AWS_REGION`: `ap-south-1`
- `S3_EVIDENCE_BUCKET`: `sakhi-evidence-758371668629`

---

## 2. Cross-Region Networking: Singapore (Render) → Mumbai (AWS RDS)

### 2.1 Networking Reality & Latency
- Render's primary Asian region is **Singapore** (`singapore`). AWS resources reside in **Mumbai** (`ap-south-1`).
- **Render Private Link** is only supported for same-region connections. Therefore, Render Singapore cannot connect to AWS Mumbai over Private Link.
- **Connection Architecture**: Connections traverse the public internet, secured by mandatory **TLS connection encryption** (`rds.force_ssl = 1` and `sslmode=require`).

### 2.2 Security Group Firewall Rules
- **No `0.0.0.0/0` Ingress**: Port 5432 is restricted to verified outbound IPs.
- **Shared vs Dedicated IP Trade-off**:
  - *Option A (Default Shared CIDRs)*: Free on Render Starter, but uses Render Singapore's shared outbound IP range. These ranges are shared among other Render customers in Singapore.
  - *Option B (Dedicated Outbound IP)*: Requires a Render **Pro workspace ($25/mo flat)** + **Dedicated IP set ($100/mo per set)**. Provides dedicated, exclusive static egress IPs for a zero-trust allowlist.

---

## 3. RDS Security: Secrets Manager & Least-Privilege User

### 3.1 RDS Master Password
- Master passwords are NOT stored in Terraform variables or `.tfvars`, avoiding plaintext credentials in `.tfstate`.
- Terraform utilizes AWS Secrets Manager integration:
  ```hcl
  manage_master_user_password = true
  ```
  AWS RDS automatically creates, manages, and rotates the master administrative secret in AWS Secrets Manager.

### 3.2 Separate Migration and Runtime Database Users
- A dedicated migration user (`sakhi_migrator`) applies checked-in Prisma migrations. A separate runtime user (`sakhi_app`) performs application CRUD only.
  ```sql
  -- Run as the RDS master user while connected to sakhi_production:
  CREATE USER sakhi_migrator WITH PASSWORD '<MIGRATION_PASSWORD>';
  CREATE USER sakhi_app WITH PASSWORD '<APP_PASSWORD>';

  GRANT CONNECT ON DATABASE sakhi_production TO sakhi_migrator, sakhi_app;
  GRANT USAGE ON SCHEMA public TO sakhi_app;
  GRANT CREATE ON SCHEMA public TO sakhi_migrator;

  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sakhi_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sakhi_app;
  ```
- Reconnect as `sakhi_migrator` and set default privileges for objects created by Prisma migrations:
  ```sql
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sakhi_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO sakhi_app;
  ```
- Configure `DATABASE_URL` with `sakhi_app` and `DIRECT_URL` with `sakhi_migrator`. The runtime user has no schema DDL privileges; the migration user is used only by the deploy-time migration command.
---

## 4. Prisma Migration & Rollback Strategy

### 4.1 Forward Corrective Migrations
- Successfully applied production migrations must **never** be rolled back using `prisma migrate resolve --rolled-back`. That command is strictly reserved for clearing a *failed* migration state from `_prisma_migrations`.
- To reverse an applied change: create a new forward corrective migration (e.g., `npx prisma migrate dev --name revert_feature`) and apply it forward via `prisma migrate deploy`.

### 4.2 Application Rollback
- If a new backend container image causes application errors, roll back immediately to the previous immutable ECR digest using the Render deploy rollback workflow (`.github/workflows/rollback-render.yml`).
- Keep previous image digests available in ECR.

---

## 5. Comprehensive Cost Model (Updated)

| Service | Tier / Plan | Monthly Cost (USD) | Notes |
| :--- | :--- | :--- | :--- |
| **AWS RDS PostgreSQL** | `db.t4g.micro` (Single-AZ, ap-south-1) | ~$15.33 | Indicative on-demand compute estimate; verify in AWS Pricing Calculator |
| **AWS RDS Storage** | 20 GiB gp3 | ~$2.62 | Indicative Mumbai estimate |
| **RDS public IPv4** | Publicly reachable RDS endpoint | ~$3.65 | Approx. $0.005/hour while allocated |
| **Secrets Manager** | RDS-managed master secret | ~$0.40 | Per secret/month, plus API calls |
| **AWS backups / transfer / logs** | Usage dependent | Variable | May add charges beyond this baseline |
| **Amazon S3 / ECR** | Existing objects and images | Usage dependent | Retention and transfer affect cost |
| **Render Web Service** | Starter instance | ~$7.00 | Compute charge, separate from workspace plan |
| **Render Pro Workspace** | Required for managed AWS OIDC | $25.00 | Flat monthly workspace fee |
| **Render Dedicated IP set** | Optional, three IPv4 addresses | $100.00 | Per set/month; not included in baseline |
| **Vercel** | Hobby frontend | $0.00 | Subject to plan eligibility and usage limits |

### Cost Summaries:
- **Hybrid baseline (Render Pro + Starter + RDS)**: approximately **$54+/month**, before usage-dependent charges and taxes.
- **With one Render dedicated outbound IP set**: approximately **$154+/month**.
- The previous <$2/month AWS budget is incompatible with always-on RDS. AWS credits may temporarily offset AWS charges only; they do not cover Render fees.
- Keep `enable_rds` and `enable_render_oidc` false until the owner approves recurring costs and verifies all network/identity inputs.

---

## 6. Security Architecture & Operational Runbooks

### 6.1 JWT Session Lifecycle & Zero-Downtime Secret Rotation
- **Strict Production Enforcement**:
  - `JWT_SECRET` must be set via environment variable with a minimum length of 32 characters.
  - Startup immediately fails (`FATAL: JWT_SECRET environment variable is missing in production`) if unset or weak.
  - Constant-time signature comparison (`crypto.timingSafeEqual`) prevents timing oracle attacks.
- **Zero-Downtime Secret Rotation Runbook**:
  1. Generate a new 32+ character cryptographically secure secret:
     ```bash
     openssl rand -hex 32
     ```
  2. Set `JWT_SECRET_PREVIOUS` to the currently active `JWT_SECRET` in Render environment settings.
  3. Set `JWT_SECRET` to the new secret generated in step 1.
  4. Deploy the service. Tokens issued under the previous secret remain valid during the transition period.
  5. Once all legacy sessions have expired (or after 7 days), remove `JWT_SECRET_PREVIOUS`.
- **Persistent Session Revocation**:
  - Tokens can be revoked immediately upon logout or compromised account detection (`POST /api/logout`).
  - Revoked token SHA-256 hashes are stored in the PostgreSQL `revoked_tokens` table until their natural expiry date.
  - The middleware verifies both signature validity and revocation status on every protected request.

### 6.2 Evidence Access Authorization Matrix
| Resource | Requester Context | Authorization Check | Result |
| :--- | :--- | :--- | :--- |
| **Owned Evidence** | Matching Owner | `req.user.userId === record.userId` | **200 OK / Download URL** |
| **Owned Evidence** | Different User | `req.user.userId !== record.userId` | **403 Forbidden** |
| **Owned Evidence** | Anonymous Requester | `!req.user` | **401 Unauthorized** |
| **Anonymous Emergency Evidence** | Bearer of `x-tracking-secret` | `SHA256(secret) === record.metadata.trackingSecretHash` | **200 OK / Download URL** |
| **Anonymous Emergency Evidence** | Missing or Invalid Secret | Hash mismatch | **403 Forbidden** |
| **Socket.IO Evidence Chunk** | Connected Client | Handshake authentication verified; client payload `userId` ignored | **Saved with verified identity** |

### 6.3 Production Database Outage Fail-Closed Behavior
In production (`NODE_ENV === 'production'`), dynamic data is NEVER written to local disk or JSON:
- `/ready`: Returns HTTP 503 (`status: unready`, `database: disconnected`) when PostgreSQL is unreachable.
- `/api/signup` & `/api/login`: Return HTTP 503 when PostgreSQL is unreachable.
- `/api/safety-reports` (GET & POST): Return HTTP 503 when PostgreSQL is unreachable.
- `/api/upload-evidence`: Throws and returns HTTP 503/500 if S3 or PostgreSQL metadata persistence fails.
