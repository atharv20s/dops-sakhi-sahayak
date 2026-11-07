# ==============================================================================
#  S3 Storage — Forensic Evidence Bucket (Private & AES256 Encrypted)
# ==============================================================================

resource "aws_s3_bucket" "evidence" {
  bucket = var.evidence_bucket_name

  lifecycle {
    ignore_changes = [tags, tags_all]
  }
}

resource "aws_s3_bucket_public_access_block" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = false
  }
}
