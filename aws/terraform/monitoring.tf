# ==============================================================================
#  CloudWatch Monitoring — Container Log Group (7-day Retention)
# ==============================================================================

resource "aws_cloudwatch_log_group" "ecs_sakhi_backend" {
  name              = var.cloudwatch_log_group_name
  retention_in_days = 7

  lifecycle {
    ignore_changes = [tags, tags_all]
  }
}
