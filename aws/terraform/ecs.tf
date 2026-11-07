# ==============================================================================
#  ECS Cluster & Task Definition (0 running tasks, 0 services)
# ==============================================================================

resource "aws_ecs_cluster" "sakhi_production" {
  name = var.ecs_cluster_name

  lifecycle {
    ignore_changes = [tags, tags_all]
  }
}

resource "aws_ecs_task_definition" "sakhi_backend" {
  family                   = "sakhi-backend-task"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_execution_role.arn
  task_role_arn            = aws_iam_role.ecs_task_role.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = "sakhi-server"
      image     = "758371668629.dkr.ecr.ap-south-1.amazonaws.com/sakhi-server@sha256:8ad1800599110e2e57b2e1de15844053f17018c8e63d699326b7445b3186ce7a"
      essential = true
      portMappings = [
        {
          name          = "sakhi-server-5001"
          containerPort = 5001
          hostPort      = 5001
          protocol      = "tcp"
          appProtocol   = "http"
        }
      ]
      environment = [
        {
          name  = "NODE_ENV"
          value = "production"
        },
        {
          name  = "PORT"
          value = "5001"
        },
        {
          name  = "S3_EVIDENCE_BUCKET"
          value = var.evidence_bucket_name
        },
        {
          name  = "AWS_REGION"
          value = var.aws_region
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = var.cloudwatch_log_group_name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])

  lifecycle {
    ignore_changes = [tags, tags_all]
  }
}
