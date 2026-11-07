# ==============================================================================
#  IAM OIDC Identity Provider — GitHub Actions Federation (Zero static secrets)
# ==============================================================================

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["ab9d0263244dd0326eb67015705a667e79cfe998"]

  lifecycle {
    ignore_changes = [tags, tags_all]
  }
}
