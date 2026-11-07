# ==============================================================================
#  ECR Container Registry — Sakhi Server
# ==============================================================================

resource "aws_ecr_repository" "sakhi_server" {
  name                 = var.ecr_repository_name
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = false
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  lifecycle {
    ignore_changes = [tags, tags_all]
  }
}
