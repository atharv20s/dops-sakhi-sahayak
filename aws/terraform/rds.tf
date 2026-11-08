# ==============================================================================
#  Optional PostgreSQL RDS — opt-in only; no resource is created by default.
#
#  Render is deployed in Singapore while AWS is in Mumbai. RDS therefore uses
#  a public endpoint with TLS, and its security group accepts TCP/5432 only
#  from the explicit Render outbound CIDR allowlist supplied by the operator.
# ==============================================================================

resource "aws_db_subnet_group" "sakhi_postgres" {
  count = var.enable_rds ? 1 : 0

  name        = "sakhi-${var.environment}-postgres-subnets"
  description = "Default VPC subnets across ap-south-1 Availability Zones for Sakhi PostgreSQL RDS"
  subnet_ids = [
    aws_default_subnet.subnet_a.id,
    aws_default_subnet.subnet_b.id,
    aws_default_subnet.subnet_c.id
  ]

  tags = {
    Name        = "sakhi-${var.environment}-postgres-subnets"
    Environment = var.environment
    ManagedBy   = "Terraform"
  }
}

resource "aws_security_group" "rds_postgres" {
  count = var.enable_rds ? 1 : 0

  name        = "sakhi-${var.environment}-rds-postgres-sg"
  description = "PostgreSQL ingress limited to verified Render outbound CIDRs"
  vpc_id      = aws_default_vpc.default.id

  dynamic "ingress" {
    for_each = var.render_outbound_cidrs
    content {
      description = "Render backend outbound range ${ingress.value}"
      from_port   = 5432
      to_port     = 5432
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "sakhi-${var.environment}-rds-postgres-sg"
    Environment = var.environment
    ManagedBy   = "Terraform"
  }
}

resource "aws_db_instance" "sakhi_postgres" {
  count = var.enable_rds ? 1 : 0

  identifier     = "sakhi-${var.environment}-postgres"
  engine         = "postgres"
  instance_class = var.rds_instance_class

  db_name  = var.rds_database_name
  username = var.rds_master_username

  # RDS creates and manages the administrative password in Secrets Manager.
  # No plaintext database password is supplied through Terraform variables.
  manage_master_user_password = true

  allocated_storage     = var.rds_allocated_storage_gib
  storage_type          = "gp3"
  storage_encrypted     = true
  auto_minor_version_upgrade = true

  port                   = 5432
  db_subnet_group_name   = aws_db_subnet_group.sakhi_postgres[0].name
  vpc_security_group_ids = [aws_security_group.rds_postgres[0].id]

  # Render's Singapore region cannot privately route to the AWS Mumbai VPC.
  # Public reachability is constrained by the CIDR-only SG rules above.
  publicly_accessible = true
  multi_az             = false

  backup_retention_period = var.rds_backup_retention_days
  copy_tags_to_snapshot   = true
  deletion_protection     = true
  skip_final_snapshot     = false
  final_snapshot_identifier = "sakhi-${var.environment}-postgres-final"

  apply_immediately = false

  tags = {
    Name        = "sakhi-${var.environment}-postgres"
    Environment = var.environment
    ManagedBy   = "Terraform"
  }

  lifecycle {
    # Explicitly prevent an accidental destroy or disable_rds toggle from
    # deleting the database. Removal requires a deliberate code change.
    prevent_destroy = true
  }
}
