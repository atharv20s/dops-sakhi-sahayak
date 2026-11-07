# ==============================================================================
#  IAM Roles & Inline Policies — Scoped Least Privilege
# ==============================================================================

# ── 1. GitHub Actions Deployment Role (OIDC Federation) ──
resource "aws_iam_role" "github_actions_role" {
  name        = "GitHubActionsSakhiRole"
  description = "OIDC role for Sakhi Sahayak GitHub Actions"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.github.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:sub" = "repo:atharv20s@224711574/dops-sakhi-sahayak@1448475494:ref:refs/heads/main"
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          }
        }
      }
    ]
  })

  lifecycle {
    ignore_changes = [tags, tags_all]
  }
}

resource "aws_iam_role_policy" "github_actions_ecr_push" {
  name = "SakhiECRPushPolicy"
  role = aws_iam_role.github_actions_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ECRAuthentication"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid    = "PushSakhiServerImage"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage"
        ]
        Resource = aws_ecr_repository.sakhi_server.arn
      }
    ]
  })
}

# ── 2. ECS Task Execution Role (Pull Image & Push Logs) ──
resource "aws_iam_role" "ecs_execution_role" {
  name        = "SakhiEcsTaskExecutionRole"
  description = "ECS execution role for Sakhi backend"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  lifecycle {
    ignore_changes = [tags, tags_all]
  }
}

resource "aws_iam_role_policy" "ecs_execution_policy" {
  name = "SakhiEcsExecutionPolicy"
  role = aws_iam_role.ecs_execution_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ECRAuthorization"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid    = "PullSakhiBackendImage"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage"
        ]
        Resource = aws_ecr_repository.sakhi_server.arn
      },
      {
        Sid    = "WriteSakhiContainerLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "${aws_cloudwatch_log_group.ecs_sakhi_backend.arn}:*"
      }
    ]
  })
}

# ── 3. ECS Task Role (Runtime S3 Evidence Access) ──
resource "aws_iam_role" "ecs_task_role" {
  name        = "SakhiEcsTaskRole"
  description = "Runtime role for Sakhi backend"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  lifecycle {
    ignore_changes = [tags, tags_all]
  }
}

resource "aws_iam_role_policy" "ecs_task_s3_policy" {
  name = "SakhiEcsTaskS3Policy"
  role = aws_iam_role.ecs_task_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListSakhiEvidenceBucket"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.evidence.arn
      },
      {
        Sid    = "ManageSakhiEvidenceObjects"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:AbortMultipartUpload",
          "s3:ListMultipartUploadParts"
        ]
        Resource = "${aws_s3_bucket.evidence.arn}/*"
      }
    ]
  })
}
