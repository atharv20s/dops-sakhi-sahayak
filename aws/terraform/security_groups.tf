# ==============================================================================
#  Security Groups — ALB SG (Legacy preserved) & ECS Tasks SG
# ==============================================================================

resource "aws_security_group" "alb_sg" {
  name        = "sakhi-alb-sg"
  description = "Security group for Sakhi ALB"
  vpc_id      = aws_default_vpc.default.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    ignore_changes = [tags, tags_all]
  }
}

resource "aws_security_group" "ecs_tasks_sg" {
  name        = "sakhi-ecs-tasks-sg"
  description = "Security group for Sakhi ECS Tasks"
  vpc_id      = aws_default_vpc.default.id

  ingress {
    from_port       = 5001
    to_port         = 5001
    protocol        = "tcp"
    security_groups = [aws_security_group.alb_sg.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    ignore_changes = [tags, tags_all]
  }
}
