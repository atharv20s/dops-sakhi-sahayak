# ==============================================================================
#  Optional Render → AWS workload identity (OIDC)
#
#  Requires Render Pro or higher. The trust is restricted to one exact Render
#  service subject. OIDC does not replace the separate ECR image-pull credential
#  used by Render for private image-backed services.
# ==============================================================================

resource "aws_iam_openid_connect_provider" "render" {
  count = var.enable_render_oidc ? 1 : 0

  url            = "https://oidc.render.com/${var.render_workspace_id}"
  client_id_list = ["sts.amazonaws.com"]

  tags = {
    Name      = "sakhi-render-${var.render_workspace_id}"
    ManagedBy = "Terraform"
  }
}

resource "aws_iam_role" "render_workload" {
  count = var.enable_render_oidc ? 1 : 0

  name        = "RenderSakhiWorkloadRole"
  description = "Short-lived OIDC role for the Sakhi Render backend to access evidence in S3"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.render[0].arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "oidc.render.com/${var.render_workspace_id}:aud" = "sts.amazonaws.com"
            "oidc.render.com/${var.render_workspace_id}:sub" = "workspace:${var.render_workspace_id}:environment:${var.render_environment_id}:service:${var.render_service_id}"
          }
        }
      }
    ]
  })

  tags = {
    Name      = "RenderSakhiWorkloadRole"
    ManagedBy = "Terraform"
  }
}

resource "aws_iam_role_policy" "render_s3_evidence" {
  count = var.enable_render_oidc ? 1 : 0

  name = "RenderSakhiEvidenceS3Policy"
  role = aws_iam_role.render_workload[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "WriteAndReadEvidenceObjects"
        Effect   = "Allow"
        Action   = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:AbortMultipartUpload",
          "s3:ListMultipartUploadParts"
        ]
        Resource = "${aws_s3_bucket.evidence.arn}/evidence/*"
      }
    ]
  })
}
