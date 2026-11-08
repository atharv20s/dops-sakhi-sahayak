variable "aws_region" {
  type        = string
  description = "AWS deployment region"
  default     = "ap-south-1"
}

variable "environment" {
  type        = string
  description = "Deployment environment"
  default     = "production"
}

variable "evidence_bucket_name" {
  type        = string
  description = "Name of the S3 evidence storage bucket"
  default     = "sakhi-evidence-758371668629"
}

variable "ecr_repository_name" {
  type        = string
  description = "Name of the backend ECR container repository"
  default     = "sakhi-server"
}

variable "ecs_cluster_name" {
  type        = string
  description = "Name of the ECS cluster"
  default     = "sakhi-production-cluster"
}

variable "cloudwatch_log_group_name" {
  type        = string
  description = "CloudWatch Log Group name for ECS containers"
  default     = "/ecs/sakhi-backend"
}

# Optional production database. Disabled by default to preserve the existing
# sub-$2/month AWS footprint until the owner explicitly opts in.
variable "enable_rds" {
  type        = bool
  description = "Create the optional PostgreSQL RDS instance. Enabling this incurs recurring AWS charges."
  default     = false

  validation {
    condition     = !var.enable_rds || length(var.render_outbound_cidrs) > 0
    error_message = "Set render_outbound_cidrs to the verified Render service outbound IPv4 CIDRs before enabling RDS. Public 0.0.0.0/0 ingress is not permitted."
  }
}

variable "rds_instance_class" {
  type        = string
  description = "RDS PostgreSQL instance class (db.t4g.micro is the low-cost single-AZ starting point)"
  default     = "db.t4g.micro"
}

variable "rds_allocated_storage_gib" {
  type        = number
  description = "Initial encrypted gp3 database storage in GiB"
  default     = 20

  validation {
    condition     = var.rds_allocated_storage_gib >= 20 && var.rds_allocated_storage_gib <= 64
    error_message = "RDS PostgreSQL gp3 storage must be between 20 and 64 GiB for this configuration."
  }
}

variable "rds_database_name" {
  type        = string
  description = "Initial PostgreSQL database name"
  default     = "sakhi_production"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_]{0,62}$", var.rds_database_name))
    error_message = "rds_database_name must begin with a lowercase letter and contain only lowercase letters, digits, or underscores."
  }
}

variable "rds_master_username" {
  type        = string
  description = "RDS administrative username; its password is managed by RDS in Secrets Manager"
  default     = "sakhi_admin"

  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9_]{0,62}$", var.rds_master_username))
    error_message = "rds_master_username must begin with a letter and contain only letters, digits, or underscores."
  }
}

variable "rds_backup_retention_days" {
  type        = number
  description = "RDS automated backup retention in days"
  default     = 1

  validation {
    condition     = var.rds_backup_retention_days >= 1 && var.rds_backup_retention_days <= 7
    error_message = "For this low-cost configuration, backup retention must be between 1 and 7 days."
  }
}

variable "render_outbound_cidrs" {
  type        = list(string)
  description = "Verified IPv4 CIDRs used by the Render backend for outbound connections to public RDS. Do not use 0.0.0.0/0."
  default     = []

  validation {
    condition = alltrue([
      for cidr in var.render_outbound_cidrs :
      can(cidrnetmask(cidr)) && cidr != "0.0.0.0/0"
    ])
    error_message = "Every Render CIDR must be a valid IPv4 CIDR and must not be 0.0.0.0/0."
  }
}

# Render-managed AWS OIDC is available on Pro workspaces and higher.
# These values are intentionally empty/disabled until the actual Render
# workspace, environment, and backend service identifiers are known.
variable "enable_render_oidc" {
  type        = bool
  description = "Create an IAM OIDC provider and least-privilege S3 role for the Render backend."
  default     = false

  validation {
    condition = !var.enable_render_oidc || (
      length(trimspace(var.render_workspace_id)) > 0 &&
      length(trimspace(var.render_service_id)) > 0 &&
      length(trimspace(var.render_environment_id)) > 0
    )
    error_message = "Set render_workspace_id, render_environment_id, and render_service_id before enabling Render OIDC."
  }
}

variable "render_workspace_id" {
  type        = string
  description = "Render workspace ID (starts with tea-); required only when Render OIDC is enabled."
  default     = ""
}

variable "render_environment_id" {
  type        = string
  description = "Render environment ID (starts with evm-), or default when the service is not in an environment."
  default     = "default"
}

variable "render_service_id" {
  type        = string
  description = "Render backend service ID (starts with srv-); required only when Render OIDC is enabled."
  default     = ""
}
