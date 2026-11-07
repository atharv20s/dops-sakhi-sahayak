# Sakhi Sahayak — AWS Infrastructure as Code (Terraform)

This directory contains the production-grade, modular Terraform codification for the **Sakhi Sahayak** women's safety platform on Amazon Web Services (AWS).

All infrastructure defined herein reflects live, operational cloud resources imported into Terraform state with **zero drift** (`No changes. Your infrastructure matches the configuration`).

---

## 1. Architectural Overview & Design Principles

The Sakhi Sahayak cloud infrastructure is designed around three strict non-negotiable principles:
1. **Forensic Security & Least Privilege**:
   - Zero static AWS access keys in code, repositories, or runtime containers.
   - GitHub Actions CI/CD uses **OIDC federation** (`token.actions.githubusercontent.com`) scoped strictly to repository `atharv20s/dops-sakhi-sahayak` and branch `main`.
   - ECS containers authenticate using runtime IAM task roles (`SakhiEcsTaskRole`) to stream encrypted evidence directly to Amazon S3.
   - S3 evidence bucket is protected with four-layer Public Access Blocks (`BlockPublicAcls`, `IgnorePublicAcls`, `BlockPublicPolicy`, `RestrictPublicBuckets`) and enforced Server-Side Encryption (`AES256`).
2. **Extreme Cost Optimization (<$2.00 USD/month)**:
   - **No persistent compute**: Fargate tasks are run on-demand or for batch verification. ECS service count is maintained at 0 ($0/hr).
   - **No Application Load Balancer (ALB)**: Persistent ALB provision is withheld ($0/hr vs ~$18/month).
   - **No NAT Gateway**: Tasks run in public subnets with assigned public IPs for egress S3 connectivity ($0/hr vs ~$32/month).
   - **Log Retention Cap**: CloudWatch Logs capped at 7 days to eliminate retention accumulation charges.
3. **Auditable & Declarative State**:
   - Every single live cloud resource is codified across isolated, domain-specific `.tf` files.
   - Every resource is imported into local state; destructive actions (`apply` / `destroy`) are strictly prohibited in this phase to prevent downtime and resource recreate cycles.

---

## 2. Codified Resources & AWS Inventory

| Resource Type | Resource Identifier | Name / ARN | Domain File |
| :--- | :--- | :--- | :--- |
| **AWS Region** | `ap-south-1` | Asia Pacific (Mumbai) | [`provider.tf`](file:///c:/Users/athar/OneDrive/Desktop/women-safety/aws/terraform/provider.tf) |
| **AWS Account** | `758371668629` | Sakhi Sahayak Production | [`main.tf`](file:///c:/Users/athar/OneDrive/Desktop/women-safety/aws/terraform/main.tf) |
| **VPC** | `vpc-0823236f9983974c1` | Default VPC (`172.31.0.0/16`) | [`networking.tf`](file:///c:/Users/athar/OneDrive/Desktop/women-safety/aws/terraform/networking.tf) |
| **Subnet A** | `subnet-01a093bc7ca9b41ef` | AZ `ap-south-1a` | [`networking.tf`](file:///c:/Users/athar/OneDrive/Desktop/women-safety/aws/terraform/networking.tf) |
| **Subnet B** | `subnet-0beb70983bcb1bfc3` | AZ `ap-south-1b` | [`networking.tf`](file:///c:/Users/athar/OneDrive/Desktop/women-safety/aws/terraform/networking.tf) |
| **Subnet C** | `subnet-0c9eeeb81214f02f3` | AZ `ap-south-1c` | [`networking.tf`](file:///c:/Users/athar/OneDrive/Desktop/women-safety/aws/terraform/networking.tf) |
| **Internet Gateway**| `igw-0490fc4e5a918249d` | Default IGW | [`networking.tf`](file:///c:/Users/athar/OneDrive/Desktop/women-safety/aws/terraform/networking.tf) |
| **Default Route Table**| `rtb-02819cabcb1d033e1` | Main Route Table (`0.0.0.0/0` -> IGW) | [`networking.tf`](file:///c:/Users/athar/OneDrive/Desktop/women-safety/aws/terraform/networking.tf) |
| **ALB Security Group** | `sg-0404e4e07937b3b4d` | `sakhi-alb-sg` (Ingress 80 from `0.0.0.0/0`) | [`security_groups.tf`](file:///c:/Users/athar/OneDrive/Desktop/women-safety/aws/terraform/security_groups.tf) |
| **ECS Tasks SG** | `sg-0d1682530312c4af3` | `sakhi-ecs-tasks-sg` (Ingress 5001 from ALB SG) | [`security_groups.tf`](file:///c:/Users/athar/OneDrive/Desktop/women-safety/aws/terraform/security_groups.tf) |
| **S3 Evidence Bucket**| `sakhi-evidence-758371668629` | Private Evidence Storage | [`storage.tf`](file:///c:/Users/athar/OneDrive/Desktop/women-safety/aws/terraform/storage.tf) |
| **S3 Public Access**| `sakhi-evidence-758371668629` | 4-layer Public Access Block | [`storage.tf`](file:///c:/Users/athar/OneDrive/Desktop/women-safety/aws/terraform/storage.tf) |
| **S3 Encryption** | `sakhi-evidence-758371668629` | SSE-S3 (`AES256`) Default Encryption | [`storage.tf`](file:///c:/Users/athar/OneDrive/Desktop/women-safety/aws/terraform/storage.tf) |
| **ECR Repository** | `sakhi-server` | Container Image Registry (Mutable, AES256) | [`ecr.tf`](file:///c:/Users/athar/OneDrive/Desktop/women-safety/aws/terraform/ecr.tf) |
| **CloudWatch Logs** | `/ecs/sakhi-backend` | 7-day Log Retention | [`monitoring.tf`](file:///c:/Users/athar/OneDrive/Desktop/women-safety/aws/terraform/monitoring.tf) |
| **ECS Cluster** | `sakhi-production-cluster`| Fargate / Container Cluster | [`ecs.tf`](file:///c:/Users/athar/OneDrive/Desktop/women-safety/aws/terraform/ecs.tf) |
| **ECS Task Definition**| `sakhi-backend-task:3` | Revision 3 (Pinned ECR Digest, Node 24) | [`ecs.tf`](file:///c:/Users/athar/OneDrive/Desktop/women-safety/aws/terraform/ecs.tf) |
| **OIDC Provider** | `token.actions.githubusercontent.com` | GitHub Actions OpenID Connect | [`oidc.tf`](file:///c:/Users/athar/OneDrive/Desktop/women-safety/aws/terraform/oidc.tf) |
| **CI/CD IAM Role** | `GitHubActionsSakhiRole` | Scoped GitHub OIDC Deployment Role | [`iam.tf`](file:///c:/Users/athar/OneDrive/Desktop/women-safety/aws/terraform/iam.tf) |
| **CI/CD IAM Policy**| `SakhiECRPushPolicy` | ECR Auth + Push Permissions | [`iam.tf`](file:///c:/Users/athar/OneDrive/Desktop/women-safety/aws/terraform/iam.tf) |
| **ECS Execution Role**| `SakhiEcsTaskExecutionRole` | ECS Agent ECR Pull & CloudWatch Logs | [`iam.tf`](file:///c:/Users/athar/OneDrive/Desktop/women-safety/aws/terraform/iam.tf) |
| **ECS Execution Policy**| `SakhiEcsExecutionPolicy` | Scoped Image Pull & Log Streams | [`iam.tf`](file:///c:/Users/athar/OneDrive/Desktop/women-safety/aws/terraform/iam.tf) |
| **ECS Task Role** | `SakhiEcsTaskRole` | Application Runtime S3 Evidence Access | [`iam.tf`](file:///c:/Users/athar/OneDrive/Desktop/women-safety/aws/terraform/iam.tf) |
| **ECS Task Policy** | `SakhiEcsTaskS3Policy` | Scoped `s3:PutObject`, `GetObject` | [`iam.tf`](file:///c:/Users/athar/OneDrive/Desktop/women-safety/aws/terraform/iam.tf) |

---

## 3. Directory Layout

```text
aws/terraform/
├── .gitignore              # Ignores .tfstate, .terraform/, *.tfplan, credentials
├── versions.tf             # Terraform requirement (>= 1.5.0) & AWS provider (~> 5.0)
├── provider.tf             # AWS provider configuration (region: ap-south-1)
├── variables.tf            # Input variables with production defaults
├── main.tf                 # Data sources (aws_caller_identity, aws_region)
├── outputs.tf              # Exported IDs, ARNs, and endpoints
├── networking.tf           # Default VPC, Subnets (a, b, c), IGW, Default Route Table
├── security_groups.tf      # sakhi-alb-sg and sakhi-ecs-tasks-sg
├── storage.tf              # sakhi-evidence-758371668629 S3 bucket, encryption, block public
├── ecr.tf                  # sakhi-server repository
├── ecs.tf                  # sakhi-production-cluster & sakhi-backend-task:3
├── monitoring.tf           # /ecs/sakhi-backend CloudWatch log group
├── oidc.tf                 # token.actions.githubusercontent.com OIDC provider
├── iam.tf                  # GitHub Actions, ECS Execution, and ECS Task roles/policies
├── audit.sh                # Read-only AWS security & cost validation script
├── FINAL_AWS_AUDIT.md      # Comprehensive audit report and live state verification
└── FINAL_STATUS.txt        # Concise PASS/FAIL gate summary
```

---

## 4. Terraform Operational Runbook

### Step 1: Initialize Workspace
The AWS provider plugin is cached locally to ensure fast, offline-capable verification:
```bash
export TF_PLUGIN_CACHE_DIR="$HOME/.terraform.d/plugin-cache"
terraform init
```

### Step 2: Validate Formatting & Syntax
Ensure canonical HCL formatting and schema compliance:
```bash
terraform fmt -check -recursive
terraform validate
```

### Step 3: Run Plan & Detect Drift
Generate a detailed execution plan to verify that the declared configuration matches real-world AWS infrastructure:
```bash
terraform plan -detailed-exitcode -out=tfplan
```
*Expected Result:*
```text
No changes. Your infrastructure matches the configuration.
Terraform has compared your real infrastructure against your configuration
and found no differences, so no changes are needed.
```

### Why `apply` and `destroy` Are Withheld
- **`terraform apply`**: Intentionally withheld because all 22 resources already exist and have been imported into state with **0 drift**. Executing apply against existing unmanaged production tags or defaults could trigger unnecessary API calls or unintended in-place modifications.
- **`terraform destroy`**: Intentionally prohibited to safeguard live evidence storage in S3 and ECR container layers.

---

## 5. Security & Cost Audit Summary

- **EC2 Running Instances**: `0`
- **Active NAT Gateways**: `0`
- **Application Load Balancers**: `0`
- **Allocated Elastic IPs**: `0`
- **ECS Running Tasks / Services**: `0` (On-demand Fargate task executed, verified, and stopped)
- **S3 Public Access Block**: `100% Active` (4/4 controls enabled)
- **S3 Server-Side Encryption**: `AES256 Enforced`
- **Total Persistent Compute Cost**: **$0.00 / month** (Comfortably inside the <$2.00/month budget)
