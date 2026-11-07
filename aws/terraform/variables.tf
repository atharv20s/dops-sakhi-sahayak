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
