# mutable-tag-ecs-updater-cdk

Updates ECS image tags based on GHCR package versions.

This CDK construct creates a Lambda that takes an ECS Service and updates the Task Container image if a package tag has been updated in Github Code Repository.

It also creates a rule to invoke this lambda at regular intervals.

## Example
