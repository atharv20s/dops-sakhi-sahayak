# ==============================================================================
#  Terraform Outputs — Audited Infrastructure IDs & Endpoints
# ==============================================================================

output "aws_region" {
  description = "AWS deployment region"
  value       = var.aws_region
}

output "vpc_id" {
  description = "Default VPC ID"
  value       = aws_default_vpc.default.id
}

output "subnet_ids" {
  description = "Subnet IDs across 3 Availability Zones"
  value = [
    aws_default_subnet.subnet_b.id,
    aws_default_subnet.subnet_a.id,
    aws_default_subnet.subnet_c.id
  ]
}

output "security_group_ecs_tasks" {
  description = "Security Group ID for ECS container tasks"
  value       = aws_security_group.ecs_tasks_sg.id
}

output "security_group_alb_legacy" {
  description = "Security Group ID for legacy ALB"
  value       = aws_security_group.alb_sg.id
}

output "evidence_bucket_name" {
  description = "S3 evidence bucket name"
  value       = aws_s3_bucket.evidence.id
}

output "evidence_bucket_arn" {
  description = "S3 evidence bucket ARN"
  value       = aws_s3_bucket.evidence.arn
}

output "ecr_repository_url" {
  description = "ECR repository URI"
  value       = aws_ecr_repository.sakhi_server.repository_url
}

output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = aws_ecs_cluster.sakhi_production.name
}

output "ecs_task_definition_arn" {
  description = "ECS Task Definition ARN"
  value       = aws_ecs_task_definition.sakhi_backend.arn
}

output "cloudwatch_log_group_name" {
  description = "CloudWatch log group for backend tasks"
  value       = aws_cloudwatch_log_group.ecs_sakhi_backend.name
}

output "iam_role_github_actions_arn" {
  description = "GitHub Actions OIDC deployment IAM role ARN"
  value       = aws_iam_role.github_actions_role.arn
}

output "iam_role_ecs_execution_arn" {
  description = "ECS Task Execution IAM role ARN"
  value       = aws_iam_role.ecs_execution_role.arn
}

output "iam_role_ecs_task_arn" {
  description = "ECS Application Task IAM role ARN"
  value       = aws_iam_role.ecs_task_role.arn
}

output "iam_oidc_provider_arn" {
  description = "GitHub Actions OIDC provider ARN"
  value       = aws_iam_openid_connect_provider.github.arn
}


# Optional resources. These remain null until their opt-in variables are enabled.
output "rds_endpoint" {
  description = "DNS endpoint for the optional Sakhi PostgreSQL RDS instance"
  value       = try(aws_db_instance.sakhi_postgres[0].address, null)
}

output "rds_port" {
  description = "Port for the optional Sakhi PostgreSQL RDS instance"
  value       = try(aws_db_instance.sakhi_postgres[0].port, null)
}

output "rds_database_name" {
  description = "Database name for the optional Sakhi PostgreSQL RDS instance"
  value       = try(aws_db_instance.sakhi_postgres[0].db_name, null)
}

output "rds_master_secret_arn" {
  description = "Secrets Manager ARN containing the RDS-managed administrative password"
  value       = try(aws_db_instance.sakhi_postgres[0].master_user_secret[0].secret_arn, null)
}

output "iam_role_render_workload_arn" {
  description = "Optional IAM role ARN to configure as AWS_ROLE_ARN on the Render backend"
  value       = try(aws_iam_role.render_workload[0].arn, null)
}

output "iam_oidc_provider_render_arn" {
  description = "Optional Render OIDC provider ARN"
  value       = try(aws_iam_openid_connect_provider.render[0].arn, null)
}
