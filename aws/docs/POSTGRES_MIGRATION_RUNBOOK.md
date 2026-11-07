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
          "oidc.render.com/<WORKSPACE_ID>:sub": "service:<RENDER_SERVICE_ID>"
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
  - *Option B (Dedicated Outbound IP)*: Requires a Render **Pro workspace ($19/mo)** + **Dedicated IP add-on ($10/mo)**. Provides dedicated, exclusive static egress IPs for a zero-trust allowlist.

---

## 3. RDS Security: Secrets Manager & Least-Privilege User

### 3.1 RDS Master Password
- Master passwords are NOT stored in Terraform variables or `.tfvars`, avoiding plaintext credentials in `.tfstate`.
- Terraform utilizes AWS Secrets Manager integration:
  ```hcl
  manage_master_user_password = true
  ```
  AWS RDS automatically creates, manages, and rotates the master administrative secret in AWS Secrets Manager.

### 3.2 Application Database User
- A dedicated application user (`sakhi_app`) is created for daily CRUD operations:
  ```sql
  CREATE USER sakhi_app WITH PASSWORD '<APP_PASSWORD>';
  GRANT CONNECT ON DATABASE sakhi_production TO sakhi_app;
  GRANT USAGE ON SCHEMA public TO sakhi_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sakhi_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sakhi_app;
  ```
  `sakhi_app` lacks `DROP TABLE`, `ALTER TABLE`, or superuser privileges.

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
| **AWS RDS PostgreSQL** | `db.t4g.micro` (Single-AZ, ap-south-1) | ~$14.60 | Accounts after July 15, 2025 have credit/promotional tiers (up to 6 months), not 12-month legacy Free Tier |
| **AWS RDS Storage** | 20 GB gp3 | ~$2.30 | $0.115/GB-month in Mumbai |
| **AWS Automated Backups** | 7-day retention (20 GB snapshot storage) | ~$1.90 | First 20 GB included free; incremental snapshots |
| **AWS S3 Storage** | Evidence audio recordings (< 10 GB) | < $0.25 | $0.023/GB-month |
| **Amazon ECR** | Container image digests | < $0.50 | $0.10/GB-month |
| **Render Web Service** | Starter Instance (Always-on, 512 MB) | **$7.00** | Zero sleep; immediate SOS latency |
| **Render Pro Workspace** *(Optional)* | Required for OIDC / Dedicated IP | **$19.00** | Workspace base fee |
| **Render Dedicated Outbound IP** *(Optional)* | Static IP address set | **$10.00** | Excludes other tenants from DB allowlist |
| **Vercel** | Hobby Tier (Frontend) | **$0.00** | Unlimited static hosting for individual projects |

### Cost Summaries:
- **Pragmatic Production (Shared Render CIDRs + Render Starter + RDS)**:
  **~$26.50 / month** (or ~$7.00/month if utilizing AWS credits).
- **Enterprise Isolation (Render Pro + Dedicated IP + Render Starter + RDS)**:
  **~$55.50 / month**.
