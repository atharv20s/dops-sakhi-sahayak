# ==============================================================================
#  Sakhi Sahayak AWS Infrastructure (Local State Management)
#  Strictly obeying <$2.00/mo spend cap: 0 ALBs, 0 NAT Gateways, 0 running tasks
# ==============================================================================

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
