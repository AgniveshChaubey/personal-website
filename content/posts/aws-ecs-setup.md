+++
date = '2026-08-09T16:04:49Z'
draft = false
title = 'What It Takes to Run ECS in Production'

tags = [ "aws", "ecs", "fargate", "containers", "docker", "iam", "load-balancing", "service-discovery", "cloud-engineering", "production-issues", "debugging", "troubleshooting", "networking" ]

categories = [ "AWS", "Cloud Engineering", "DevOps" ]

description = "A complete walkthrough of every ECS building block, plus a field guide of the real errors we hit during a production Fargate rollout -- each one linked to the concept that explains it."
+++

We recently moved a multi-service application -- a couple of backend APIs and a dashboard -- onto Amazon ECS with Fargate. On paper it's simple: write a task definition, create a service, put a load balancer in front. In practice, getting to *production-grade* meant properly understanding ECS's two-role IAM model, `awsvpc` networking, service-to-service discovery, volume mounts, and the subtle interplay between container and load balancer health checks.

We also hit a lot of errors along the way. Rather than hiding them, this post embraces them: the first half walks through each ECS component, and the second half is a [troubleshooting guide](#troubleshooting-guide) with the actual errors we faced, their root causes, and fixes.

**Contents:** [Why ECS](#why-ecs) | [The building blocks](#the-building-blocks) | [The task definition](#the-task-definition) | [The service](#the-service) | [IAM roles](#iam-execution-role-vs-task-role) | [Security groups](#security-groups-zero-trust-by-default) | [Troubleshooting guide](#troubleshooting-guide)

## Why ECS

Amazon ECS is AWS's native container orchestrator -- more robust than `docker compose` on an EC2 box (self-healing, rolling deployments, autoscaling, load balancer integration), yet far less operationally demanding than Kubernetes. With the **Fargate** launch type there are no servers to manage at all: you declare CPU and memory per task, and AWS runs it. If you need the Kubernetes ecosystem or multi-cloud portability, EKS is the better fit; for everything else, ECS on Fargate is hard to beat.

## The building blocks

ECS has three core concepts, arranged in a simple hierarchy:

- **Cluster** -- the top-level logical container that groups your services and tasks.
- **Task definition** -- a versioned *blueprint* describing the containers to run: images, resources, roles, networking, and volumes.
- **Service** -- the long-running supervisor that keeps N copies of a task definition alive and wires them into load balancers and service discovery.

### The cluster

The cluster is mostly an organizational boundary. When you use Fargate, there are no container instances to register or manage -- the cluster is essentially a namespace plus capacity provider settings (e.g., `FARGATE` vs `FARGATE_SPOT`). Create it once and move on; the real decisions live in the task definition and service.

## The task definition

The [task definition](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html) is the blueprint of the containers that will run in your cluster. Every change creates a new *revision*, and services point at a specific revision -- which is what makes rollbacks trivial. Here's what you'll configure, and where the sharp edges are.

### Launch type and network mode

**Compute / launch type.** Task definitions declare compatibility with one or more launch types: **`FARGATE`** (serverless -- AWS provisions the compute), **`EC2`** (tasks run on container instances you manage), or **`EXTERNAL`** (ECS Anywhere, for on-prem/edge servers). We use Fargate throughout this post.

**Network mode.** Fargate supports exactly one mode: **`awsvpc`**, where every task gets its own Elastic Network Interface (ENI) and its own private IP -- the task behaves like a first-class citizen of your VPC. On the EC2 launch type you additionally get `bridge` (Docker's classic bridge network with host-port remapping), `host` (share the host's network stack), and `none`.

The `awsvpc` model is a genuine security and observability win, but it has one consequence people trip over: since there's no port-remapping layer, host and container ports must match in your port mappings.

> **Related error:** [Error 4 -- host and container ports must match under awsvpc](#error-4-host-and-container-ports-must-match-under-awsvpc)

### Task-level CPU and memory

On Fargate, `cpu` and `memory` are **required at the task level**, and only [specific combinations](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html#task_size) are valid -- for example, `256` CPU units (0.25 vCPU) pairs with 512 MB-2 GB of memory, `1024` (1 vCPU) pairs with 2–8 GB, and so on. This is because Fargate provisions (and bills) an exact task-sized slice of compute, so it must know the size upfront. On the EC2 launch type these are optional at the task level, but then each container must declare `memory` or `memoryReservation` instead.

Forget any of this and the task definition won't even register:

> **Related error:** [Error 1 -- Fargate needs CPU and memory at the task level](#error-1-fargate-needs-cpu-and-memory-at-the-task-level)

### Execution role and task role

A task definition takes **two** role ARNs -- `executionRoleArn` and `taskRoleArn` -- and confusing them is probably the single most common source of ECS errors. The short version: the *execution role* is used by the ECS/Fargate infrastructure to **set your task up** (pull the image, ship logs, fetch secrets), while the *task role* is assumed by **your application code** at runtime to call AWS APIs and perform IAM-authorized volume mounts. Both are covered in depth in the [IAM section](#iam-execution-role-vs-task-role).

> **Related errors:** [Error 2](#error-2-awslogs-on-fargate-needs-an-execution-role), [Error 3](#error-3-s3-files-authorization-needs-a-task-role), [Error 6](#error-6-access-denied-while-mounting-the-volume)

### Container definitions

Inside the task definition, each [container definition](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ContainerDefinition.html) describes one container: the `image` to run, plus the four blocks below that deserve real attention.

#### Port mappings

Each [port mapping](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_PortMapping.html) exposes a container port, and two of its optional fields become mandatory the moment you adopt Service Connect:

- **`name`** -- required if you want to use [Service Connect](#service-connect) for inter-service communication; the service will reference the mapping by this name.
- **`appProtocol`** -- set it to whatever your application speaks: `http`, `http2`, or `grpc`. Service Connect's proxy uses this for protocol-aware routing and per-request telemetry.
- **`containerPort` / `hostPort`** -- under `awsvpc`, these must be equal (or simply omit `hostPort` and it defaults to `containerPort`). See [Error 4](#error-4-host-and-container-ports-must-match-under-awsvpc).

#### Log configuration

For Fargate, the [supported log drivers](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_LogConfiguration.html) are `awslogs`, `splunk`, and `awsfirelens`. Unless you have a strong reason otherwise, `awslogs` (CloudWatch Logs) is the simplest and works out of the box:

```json
"logConfiguration": {
  "logDriver": "awslogs",
  "options": {
    "awslogs-group": "/ecs/myapp-api",
    "awslogs-region": "us-east-1",
    "awslogs-stream-prefix": "api"
  }
}
```

One thing that isn't obvious: with `awslogs` on Fargate, it's the **platform** -- not your container -- that pushes stdout/stderr to CloudWatch, and it does so using the *execution role's* credentials. That's why Fargate flat-out refuses to register a task definition that uses `awslogs` without an execution role.

> **Related error:** [Error 2 -- awslogs on Fargate needs an execution role](#error-2-awslogs-on-fargate-needs-an-execution-role)

#### Health checks

The container-level [`healthCheck`](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_HealthCheck.html) lets ECS probe the service running *inside* the container:

```json
"healthCheck": {
  "command": ["CMD-SHELL", "curl -f http://localhost:3000/health || exit 1"],
  "interval": 30,
  "timeout": 5,
  "retries": 3,
  "startPeriod": 60
}
```

The `command` is a string array that ECS executes **inside your container** -- which means every utility it references must actually exist in your image. If your image is Alpine or distroless-based and doesn't ship `curl`, the check above exits non-zero every single time, ECS marks the container unhealthy, and your perfectly fine tasks get killed in an endless loop.

Also, keep firmly in mind that this check is **not** the same as your ALB target group's health check -- they are independent, and *either* can get your task replaced. More on that in [Error 11](#error-11-tasks-restart-even-though-the-container-health-check-passes).

#### Mount points

[`mountPoints`](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_MountPoint.html) attach volumes into the container: you specify the `sourceVolume` (a name matching a task-level volume), the `containerPath` where it appears, and optionally `readOnly`. The volume itself -- its actual type and configuration -- is defined at the task-definition level, covered next.

Two gotchas that both bit us: you can only mount **directories, not individual files**, and mounting a volume onto a directory that already contains files **shadows** the existing content (exactly like a Docker bind mount).

> **Related errors:** [Error 7](#error-7-not-a-directory-when-mounting-onto-a-file-path), [Error 8](#error-8-the-mount-hid-the-application-binary)

### Volumes

At the task-definition level you declare the [volumes](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/using_data_volumes.html) your containers will mount. The common options:

- **Amazon EBS** -- block storage attached to a single task; good for stateful workloads that need fast local-style disks.
- **Amazon EFS** -- an elastic, shared NFS file system that many tasks can mount simultaneously.
- **[S3 Files](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/s3files-volumes.html)** -- mounts an S3-backed file system directly into your containers with full file-system semantics, while keeping the data in your S3 bucket.

For our use case -- containers that only need to **read** configuration files -- S3 Files turned out to be the cost-effective choice: the data lives in cheap S3 storage instead of a provisioned file system. It does have trade-offs, though. It's a poor fit when data written by one process must be immediately read back by another, and there are other sharp edges worth knowing -- [this write-up](https://awsfundamentals.com/blog/aws-s3-files) covers them well.

Operationally, S3 Files behaves a lot like EFS (it's even mounted via the EFS mount helper under the hood): you need a **mount target in every Availability Zone** your tasks can launch into, the **task role** needs mount permissions, and -- as noted above -- you mount directories, never single files.

> **Related errors:** [Error 5](#error-5-no-mount-target-in-the-task-az), [Error 6](#error-6-access-denied-while-mounting-the-volume), [Error 7](#error-7-not-a-directory-when-mounting-onto-a-file-path)

## The service

If the task definition is the blueprint, the **service** is the supervisor. It declares which task-definition revision to run, the `desired_count` of tasks, the launch type, and the deployment settings -- then continuously reconciles reality against that declaration, replacing any task that dies or goes unhealthy. It's also where your tasks get wired into the network, the load balancer, and service discovery.

### Network configuration

Because our tasks use `awsvpc` mode, the service's [`network_configuration`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/ecs_service#network_configuration-block) block is **required**: the subnets to place task ENIs in (private subnets, ideally), the security groups to attach, and whether to assign public IPs (for private subnets behind a NAT: no).

A nasty default hides here: if you omit `security_groups`, AWS silently attaches your VPC's **default security group** to every task ENI. Unless your ALB also happens to use the default SG, it can no longer reach your containers -- and your target group health checks time out with no obvious cause.

> **Related error:** [Error 10 -- health checks fail because of the default security group](#error-10-health-checks-fail-because-of-the-default-security-group)

### Load balancer integration

To expose the application to the internet, the service's [`load_balancer`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/ecs_service#load_balancer-block) block ties tasks to an ALB target group. You supply the `target_group_arn` plus the `container_name` and `container_port` -- which must match the task definition exactly -- and ECS takes care of registering and deregistering each task's ENI in the target group as tasks come and go.

Be aware of what you're signing up for: once a service is attached to a target group, **the target group's health verdict governs the task's fate**. A target the ALB deems unhealthy will be drained and replaced by ECS -- even if the container-level health check is green.

> **Related errors:** [Error 10](#error-10-health-checks-fail-because-of-the-default-security-group), [Error 11](#error-11-tasks-restart-even-though-the-container-health-check-passes)

### Service Connect

For service-to-service communication -- the dashboard calling the usr API, the usr API calling the subs API -- ECS's answer is [Service Connect](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/ecs_service#service_connect_configuration-block). Set `enabled = true` and give it a **namespace**: a Cloud Map HTTP namespace (Terraform: [`aws_service_discovery_http_namespace`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/service_discovery_http_namespace)), which is simply a logical registry where ECS records your services so they can find each other by friendly names instead of IPs.

Then, in the [`service`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/ecs_service#service-block) block:

```hcl
service_connect_configuration {
  enabled   = true
  namespace = aws_service_discovery_http_namespace.this.arn

  service {
    port_name      = "api"       # must match a *named* portMapping in the task definition
    discovery_name = "usr-api"  # the Cloud Map name ECS creates; what other services call

    client_alias {
      port = 3000                # -> reachable at http://usr-api:3000
    }
  }
}
```

- **`port_name`** is required and must be the name of one of the `portMappings` across the containers in the task definition -- which is why we said [naming your port mappings](#port-mappings) matters.
- **`discovery_name`** is the name of the new Cloud Map service that ECS creates for this ECS service; combined with the client alias, it becomes the address other services use.

Under the hood, ECS injects a lightweight proxy sidecar into each task that handles resolution, routing, and telemetry. But the traffic still flows task-to-task over your VPC -- so your security groups must allow it, or every inter-service call will hang and time out. See [security groups](#security-groups-zero-trust-by-default).

### ECS Exec

With Fargate there is no host to SSH into, so the only way to get a shell inside a running container is [ECS Exec](https://aws.amazon.com/blogs/containers/new-using-amazon-ecs-exec-access-your-containers-fargate-ec2/) -- and it only works if you set **`enable_execute_command = true` on the service** *before* the task starts. Do it now, on day one, even if you don't need it yet: the first time a target group turns unhealthy and you need to poke around inside the container, you'll be very glad it's on.

With the flag enabled (and the [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) installed for your AWS CLI), you can exec in like this:

```bash
aws ecs execute-command \
  --region <region> \
  --cluster <your-ecs-cluster> \
  --task <task-id-or-arn> \
  --container <container-name-as-per-task-definition> \
  --command "bash" \
  --interactive
```

> **Related error:** [Error 9 -- cannot exec into the container](#error-9-cannot-exec-into-the-container)

## IAM: execution role vs task role

That's most of the ECS infrastructure. Now for the part that generates the most confusion -- and, in our experience, the most errors: the two IAM roles.

**The task execution role** is used by the ECS agent and the Fargate platform itself -- *not* by your code -- to bootstrap the task. Concretely, that means pulling the container image from ECR, creating CloudWatch log groups/streams and pushing your container's logs, and fetching secrets from Secrets Manager or SSM Parameter Store to inject as environment variables. The AWS-managed policy covers the basics, so attach it:

```bash
arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
```

**The task role**, on the other hand, is what your **application** assumes at runtime -- think of it as the ECS equivalent of an EC2 instance profile. Any AWS API your code calls (S3, DynamoDB, SQS, …) is authorized through this role, with credentials delivered automatically via the task metadata endpoint. It's also the identity used for **IAM-authorized volume mounts**: for S3 Files, the task role must carry `s3files:ClientMount` alongside your other permissions, or the container will fail to mount the file system at startup:

```json
{
  "Sid": "S3FilesPermissions",
  "Effect": "Allow",
  "Action": [
    "s3files:ClientMount"
  ],
  "Resource": [
    "*"
  ]
}
```

(In production, scope `Resource` down to your file system's ARN rather than `*`.)

A litmus test that resolves 90% of the confusion: *"Does ECS need this permission to **start** my container?"* → execution role. *"Does my code need it **while running**?"* → task role.

> **Related errors:** [Error 2](#error-2-awslogs-on-fargate-needs-an-execution-role), [Error 3](#error-3-s3-files-authorization-needs-a-task-role), [Error 6](#error-6-access-denied-while-mounting-the-volume)

## Security groups: zero trust by default

For network security, adopt a zero-trust posture from the start: attach explicit security groups to **every** applicable resource and allow traffic only from known sources. SG-to-SG reference rules (allowing traffic *from another security group* rather than from CIDR ranges) are the cleanest way to express this.

For a typical ALB-fronted ECS setup:

- **ALB security group** -- allow `443` (and `80` for redirects) from the internet, or from the CloudFront prefix list if you front it with a CDN.
- **ECS service security group** -- allow the container ports (`3000`, `80`, or whatever your apps listen on) **only from the ALB's security group**, plus a **self-referencing rule** (or your private subnet CIDRs) so that Service Connect's task-to-task traffic can flow. This second rule is easy to forget and absolutely required -- without it, inter-service calls will simply time out.

Nothing on the tasks should be reachable from anywhere else. And remember the flip side from the [network configuration](#network-configuration) section: forgetting to specify security groups at all silently gives you the VPC default SG, which breaks things in its own way ([Error 10](#error-10-health-checks-fail-because-of-the-default-security-group)).

## Troubleshooting guide

Everything below is an error we actually hit during this rollout, grouped into two buckets: **registration-time errors**, which fail your `terraform apply` (or `RegisterTaskDefinition` call) with an HTTP 400, and **runtime errors**, where the task definition registers fine but tasks stop or never become healthy. Each entry links back to the section that explains the underlying concept.

### Registration-time errors

#### Error 1: Fargate needs CPU and memory at the task level

```bash
Error: creating ECS Task Definition (myapp-subs-api-task): operation error ECS:
RegisterTaskDefinition, https response error StatusCode: 400,
ClientException: Fargate requires that 'cpu' be defined at the task level.

ClientException: Fargate requires that 'memory' be defined at the task level.

ClientException: At least one of 'memory' or 'memoryReservation' must be specified.
```

**Cause:** Fargate provisions an exact task-sized slice of compute, so `cpu` and `memory` are mandatory at the task level and must be one of the [valid combinations](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html#task_size). The third variant appears when task-level memory is absent *and* the container definitions don't declare `memory`/`memoryReservation` either (that's the EC2-launch-type way of sizing).

**Fix:** Set both `cpu` and `memory` at the task level with a valid pairing (e.g., `cpu = 512`, `memory = 1024`) and all three errors disappear.

*Concept: [Task-level CPU and memory](#task-level-cpu-and-memory)*

#### Error 2: awslogs on Fargate needs an execution role

```bash
Error: creating ECS Task Definition (myapp-dashboard-task): operation error ECS:
RegisterTaskDefinition, https response error StatusCode: 400,
ClientException: Fargate requires task definition to have execution role ARN
to support log driver awslogs.
```

**Cause:** The "why" here confused us at first. With the `awslogs` driver on Fargate, your container doesn't ship its own logs -- the **Fargate platform** collects stdout/stderr and pushes it to CloudWatch *on your behalf*, using the execution role's credentials (`logs:CreateLogStream`, `logs:PutLogEvents`, …). No execution role means the platform has no identity to push logs with, so ECS rejects the task definition outright rather than letting you deploy something that can never log.

**Fix:** Create an execution role, attach `AmazonECSTaskExecutionRolePolicy`, and set `execution_role_arn` on the task definition.

*Concept: [IAM -- execution role vs task role](#iam-execution-role-vs-task-role), [Log configuration](#log-configuration)*

#### Error 3: S3 Files authorization needs a task role

```bash
Error: creating ECS Task Definition (myapp-usr-api-task): operation error ECS:
RegisterTaskDefinition, https response error StatusCode: 400,
ClientException: S3 Files IAM authorization requires a task role.
```

**Cause:** The classic `task_role_arn` vs `execution_role_arn` mix-up. IAM-authorized volume mounts happen under the **task role's** identity -- an execution role alone isn't enough, because mounting is something done *as* the task, not as the platform.

**Fix:** Set `task_role_arn` on the task definition, and make sure that role carries `s3files:ClientMount` (see [the IAM section](#iam-execution-role-vs-task-role) for the policy snippet) -- otherwise you'll clear this error only to hit [Error 6](#error-6-access-denied-while-mounting-the-volume) at runtime.

*Concept: [IAM -- execution role vs task role](#iam-execution-role-vs-task-role)*

#### Error 4: Host and container ports must match under awsvpc

```bash
Error: creating ECS Task Definition (myapp-api-task): operation error ECS:
RegisterTaskDefinition, https response error StatusCode: 400,
ClientException: When networkMode=awsvpc, the host ports and container ports
in port mappings must match.
```

**Cause:** In `awsvpc` mode, every task has its own ENI and private IP, so there's no host-port remapping layer like Docker's bridge network -- a "host port" different from the container port is meaningless.

**Fix:** Set `hostPort` equal to `containerPort`, or just omit `hostPort` entirely and it defaults correctly.

*Concept: [Launch type and network mode](#launch-type-and-network-mode), [Port mappings](#port-mappings)*

### Runtime errors

#### Error 5: No mount target in the task AZ

```bash
ResourceInitializationError: failed to invoke EFS utils commands to set up EFS volumes:
stderr: Failed to resolve "use1-az2.fs-xxxxxxxxxxxxxxxxx.s3files.us-east-1.on.aws" -
check that your file system ID is correct, and ensure that the VPC has an S3 Files
mount target for this file system ID. : unsuccessful EFS utils command execution; code: 1
```

**Cause:** Look closely at the hostname the task failed to resolve -- it's **AZ-scoped** (`use1-az2.…`). Mount targets exist per Availability Zone, and this task launched in a subnet in `use1-az2` where no mount target had been created. (Don't be thrown by the "EFS utils" wording: S3 Files is mounted through the EFS mount helper under the hood.)

**Fix:** Create a mount target (`aws_s3files_mount_target`) in **every** AZ/subnet your service can place tasks into.

*Concept: [Volumes](#volumes)*

#### Error 6: Access denied while mounting the volume

```bash
ResourceInitializationError: failed to invoke EFS utils commands to set up EFS volumes:
stderr: b'mount.nfs4: access denied by server while mounting 127.0.0.1:myapp/filestorage'
: unsuccessful EFS utils command execution; code: 32
```

**Cause:** The mount is IAM-authorized, and the task role was missing `s3files:ClientMount`. The server accepted the connection but refused the mount because the caller's identity had no right to it.

**Fix:** Add `s3files:ClientMount` to the **task role** (the JSON snippet is in [the IAM section](#iam-execution-role-vs-task-role)). This is the runtime twin of [Error 3](#error-3-s3-files-authorization-needs-a-task-role): that one fires when the role is absent, this one when the role exists but lacks the permission.

*Concept: [IAM -- execution role vs task role](#iam-execution-role-vs-task-role), [Volumes](#volumes)*

#### Error 7: Not a directory when mounting onto a file path

```bash
CannotStartContainerError: ResourceInitializationError: failed to create new container
runtime task: failed to create shim task: OCI runtime create failed: runc create failed:
unable to start container process: error during container init: error mounting
"/var/lib/.../volumes/<volume-id>/api" to rootfs at "/MyApp/Appsettings.json":
... flags=MS_RDONLY|MS_BIND ... : not a directory
```

**Cause:** We tried to mount our config volume directly onto a *file* path (`/MyApp/Appsettings.json`). S3 Files doesn't support mounting a single file -- only directories -- so the runtime was handed a directory as the mount source and a file as the destination, and rightly refused.

**Fix:** Two options: **(a)** change the application to read its config from a directory you control, e.g. mount at `/config` and point the app at `/config/appsettings.json`; or **(b)** mount the volume at a different directory and create a symlink at the expected path in your entrypoint:

```bash
ln -s /config/appsettings.json /MyApp/Appsettings.json
```

We went with (b), since it required zero application changes.

*Concept: [Mount points](#mount-points), [Volumes](#volumes)*

#### Error 8: The mount hid the application binary

No dramatic AWS error string for this one -- just a container that exited immediately because its own binary "wasn't there anymore."

**Cause:** We mounted a volume onto a directory that already contained files -- the application's own directory. Exactly like a Docker bind mount, the volume **shadows** whatever was at that path in the image, so the app binary and everything beside it became invisible.

**Fix:** Always mount volumes at dedicated, empty paths (`/config`, `/data`, `/mnt/files`) -- never on top of directories the image actually needs.

*Concept: [Mount points](#mount-points)*

#### Error 9: Cannot exec into the container

The target group was reporting unhealthy, and the obvious next question was: *is everything actually working inside the container?* On Fargate the only way to check is ECS Exec -- which greeted us with:

```bash
An error occurred (InvalidParameterException) when calling the ExecuteCommand operation:
The execute command failed because execute command was not enabled when the task was run
or the execute command agent isn't running. Wait and try again or run a new task with
execute command enabled and try again.
```

**Cause:** `enable_execute_command` was never set on the service, and the flag only applies to tasks **started after** it's enabled.

**Fix:** Set `enable_execute_command = true` on the service, force a new deployment so fresh tasks pick it up, make sure the [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) is installed for your AWS CLI and the task role has the `ssmmessages` permissions, then:

```bash
aws ecs execute-command \
  --region us-east-1 \
  --cluster ecs-cluster \
  --task arn:aws:ecs:us-east-1:<account-id>:task/ecs-cluster/<task-id> \
  --command "bash" \
  --interactive
```

([AWS's ECS Exec announcement post](https://aws.amazon.com/blogs/containers/new-using-amazon-ecs-exec-access-your-containers-fargate-ec2/) covers the full setup.)

*Concept: [ECS Exec](#ecs-exec)*

#### Error 10: Health checks fail because of the default security group

**Symptom:** Target group shows every target `Unhealthy`; health checks time out; yet exec into the container ([Error 9](#error-9-cannot-exec-into-the-container)) shows the app running fine and responding on `localhost`.

**Cause:** `security_groups` was omitted from the service's `network_configuration`. When you leave it out in an `awsvpc` configuration on Fargate, AWS automatically attaches the VPC's **default security group** to each task's ENI. Unless your ALB also uses the default SG, the ALB's health-check traffic never reaches the container ports (`3000`, `80`, etc.) -- so checks time out and the targets sit at `Unhealthy` forever.

**Fix:** Always pass an explicit security group in `network_configuration`, with an inbound rule allowing your container ports **from the ALB's security group**.

*Concept: [Network configuration](#network-configuration), [Security groups](#security-groups-zero-trust-by-default)*

#### Error 11: Tasks restart even though the container health check passes

**Symptom:** The container-level health check is green, yet ECS keeps stopping and replacing tasks.

**Cause:** The container health check and the ALB target group health check are **independent, and both can kill your task**. The container check runs *inside* the container (e.g., `curl localhost`), while the ALB checks arrive *over the network* from the load balancer nodes to the task's ENI. Once a service is attached to a target group, ECS folds the target's health into the task's health: when the ALB marks a target unhealthy, ECS drains and replaces that task -- regardless of what the container check says.

The two verdicts diverge whenever something breaks the *network path* but not the app itself:

- a security group blocking the ALB (see [Error 10](#error-10-health-checks-fail-because-of-the-default-security-group));
- a wrong health-check **path or port** on the target group;
- the app binding to `127.0.0.1` instead of `0.0.0.0` -- reachable from inside, invisible from outside;
- a success-code mismatch (the target group's matcher expects `200`, the app answers the health path with a `3xx` redirect);
- a slow-starting app failing its first checks before it's ready.

**Fix:** Work through the list above, and for slow starters set `health_check_grace_period_seconds` on the service so ECS ignores ALB health results during startup. Keep the two checks intentionally consistent -- same path, same port, same expectation.

*Concept: [Health checks](#health-checks), [Load balancer integration](#load-balancer-integration)*

## Wrapping up

Looking back at eleven errors, nearly all of them trace to just two themes: the **two-role IAM model** (Errors 2, 3, 6 -- remember the litmus test: *starting* the container is the execution role, *running* your code is the task role) and **networking under `awsvpc`** (Errors 4, 5, 10, 11 -- explicit security groups, matching ports, mount targets in every AZ, and respect for the ALB's verdict).

If you're about to do a similar rollout, here's the checklist we wish we'd had on day one:

- [ ] Task-level `cpu` and `memory` set, from a valid Fargate combination
- [ ] Execution role with `AmazonECSTaskExecutionRolePolicy` **and** a task role for your app (plus `s3files:ClientMount` if you use S3 Files)
- [ ] `hostPort` = `containerPort` (or omitted), port mappings **named** if you'll use Service Connect
- [ ] Health-check command uses a utility that actually exists in your image
- [ ] Explicit security groups: container ports from the ALB SG + a self-referencing rule for inter-service traffic
- [ ] Volume mount targets in **every** AZ your tasks can launch into; volumes mounted at dedicated empty directories
- [ ] `enable_execute_command = true` from day one
- [ ] `health_check_grace_period_seconds` set for slow-starting services

ECS on Fargate genuinely delivers on the "production-grade with minimal ops" promise -- but only once you understand *why* each of these pieces exists. Hopefully this saves you a few of the debugging hours it cost us.
