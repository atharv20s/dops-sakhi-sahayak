# ==============================================================================
#  Networking — Default VPC & Subnets across 3 Availability Zones
# ==============================================================================

resource "aws_default_vpc" "default" {
  lifecycle {
    ignore_changes = [tags, tags_all]
  }
}

resource "aws_default_subnet" "subnet_b" {
  availability_zone = "ap-south-1b"

  lifecycle {
    ignore_changes = [tags, tags_all]
  }
}

resource "aws_default_subnet" "subnet_a" {
  availability_zone = "ap-south-1a"

  lifecycle {
    ignore_changes = [tags, tags_all]
  }
}

resource "aws_default_subnet" "subnet_c" {
  availability_zone = "ap-south-1c"

  lifecycle {
    ignore_changes = [tags, tags_all]
  }
}

resource "aws_internet_gateway" "default" {
  vpc_id = aws_default_vpc.default.id

  lifecycle {
    ignore_changes = [tags, tags_all]
  }
}

resource "aws_default_route_table" "default" {
  default_route_table_id = aws_default_vpc.default.default_route_table_id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.default.id
  }

  lifecycle {
    ignore_changes = [tags, tags_all]
  }
}
