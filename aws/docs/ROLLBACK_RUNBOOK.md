# Sakhi Sahayak — AWS Deployment Rollback Runbook

## 1. Purpose

This runbook documents how to recover from a faulty backend release
when Sakhi Sahayak is deployed to AWS ECS.

Current operating constraint:
- No permanent ECS service or running task.
- No ALB or NAT Gateway.
- No live ECS rollback has been performed.
- Deployment preparation is permitted; production deployment is not.

## 2. Release identification

Every CI release publishes immutable identifiers:

- Git commit SHA
- ECR image tag based on the commit SHA
- ECR image digest
- Docker image URI

Example format:

758371668629.dkr.ecr.ap-south-1.amazonaws.com/sakhi-server@sha256:<digest>

Use the image digest as the authoritative image identifier.
Do not rely on the mutable `latest` tag for rollback.

## 3. Pre-deployment checklist

Before a future ECS deployment:

1. Confirm backend automated tests pass.
2. Confirm frontend build succeeds.
3. Confirm the Docker image was pushed successfully.
4. Record the currently deployed task definition revision.
5. Record the currently deployed image digest.
6. Preserve the last known-good task definition and image digest.
7. Confirm the deployment approval and AWS budget authorization.

## 4. Rollback decision criteria

Consider rollback when:

- ECS tasks repeatedly fail health checks.
- The backend fails to start.
- Application logs show critical runtime errors.
- The deployment causes persistent API failures.
- The new release performs materially worse than the previous release.

## 5. Future ECS rollback procedure

When an ECS service is introduced and deployment is explicitly approved:

1. Identify the last known-good task definition revision.
2. Confirm its container image references the known-good ECR digest.
3. Register or restore the previous task definition revision as appropriate.
4. Update the ECS service to use the known-good task definition.
5. Wait for ECS service stability.
6. Verify ECS task health and application health endpoints.
7. Inspect CloudWatch logs for errors.
8. Confirm the service is operating on the expected image digest.

Example commands for a future approved deployment:

    aws ecs describe-services \
      --cluster sakhi-production-cluster \
      --services <service-name> \
      --region ap-south-1

    aws ecs update-service \
      --cluster sakhi-production-cluster \
      --service <service-name> \
      --task-definition <known-good-task-definition-revision> \
      --region ap-south-1

These commands are documentation only. Do not execute them until an ECS
service exists and deployment has been explicitly approved.

## 6. Terraform ownership

Terraform remains the source of truth for infrastructure.

Do not manually change Terraform-managed infrastructure and leave
configuration drift unresolved.

Before a future rollback:
- Establish how task definition revisions and image digests are managed.
- Update the Terraform configuration to represent the intended state.
- Review the Terraform plan before applying any approved change.

Never run terraform apply or terraform destroy as an emergency guess.

## 7. Post-rollback verification

After a future rollback:

- Confirm ECS service stability.
- Confirm the expected task definition revision.
- Confirm the expected ECR image digest.
- Verify GET /health returns HTTP 200.
- Verify GET /api/health returns HTTP 200.
- Inspect CloudWatch logs.
- Run application smoke tests.
- Record the failed release and rollback outcome.

## 8. Current project status

The project currently has:
- Automated backend tests.
- Backend health endpoints.
- Docker HEALTHCHECK configuration.
- GitHub Actions CI and ECR image publishing.
- Terraform-managed infrastructure state.

The project does not currently have:
- A permanent ECS service.
- A production deployment.
- A live ECS health-check test.
- A live ECS rollback test.

No AWS compute resources are started by this runbook.
