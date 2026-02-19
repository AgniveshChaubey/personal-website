+++
date = '2026-02-19T17:53:12Z'
draft = false
title = 'When Security Upgrades Create Infrastructure Deadlocks'


tags = [ "azure", "vmss", "trusted-launch", "azure-compute-gallery", "infrastructure", "cloud-security", "devops", "image-pipeline" ]
categories = [ "Azure", "Cloud Architecture", "DevOps", "Infrastructure" ]

description = ""

+++

Recently, while upgrading the **security type of our Azure VMs**, I ran into a classic _chicken-and-egg_ production problem. What looked like a simple **Azure Advisor recommendation** turned into a deployment deadlock that forced us to rethink our image pipeline.

The recommendation was to upgrade our VM security type from **Standard** to **Trusted Launch**.

Our deployment flow is simple:

- A Deployment VM is prepared.
- An Azure Automation Runbook creates a VM image.
- The image is stored in **Azure Managed Image** (legacy).
- The VM Scale Set (VMSS) image reference is updated.
- Instances roll out.

---

Everything worked fine -- until we upgraded the Deployment VM to `TrustedLaunch`.

After the upgrade, the runbook started failing at the image creation step.

The error was roughly like this:

```text
The image cannot be created because Managed Images do not support Trusted Launch enabled virtual machines. Please use Azure Compute Gallery.
```

Turns out, **Managed Images [do not support](https://learn.microsoft.com/en-us/azure/virtual-machines/trusted-launch#unsupported-features) Trusted Launch images**. Microsoft recommends using **Azure Compute Gallery** instead.

So we created:

- An Azure Compute Gallery
- An Image Definition
- Stored image versions there

Now image creation worked.

But the next step, i.e., updating the VMSS image reference -- failed.

Error looked something like:

```text
Virtual Machine Scale Set cannot reference an image with security type 'TrustedLaunch' while the scale set security type is 'Standard'.
```

Fine. Let's update the VMSS security type to `TrustedLaunch`.

Nope.

That failed too:

```text
Cannot update VMSS security profile because the current image reference is not compatible with TrustedLaunch.
```

And there it was.

- VMSS can't use TrustedLaunch image because it's Standard.
- VMSS can't upgrade to TrustedLaunch because it's referencing a Standard image.

Deadlock.

The obvious solution was to delete and recreate the VMSS with `TrustedLaunch` enabled. But that would mean additional downtime, updating Application Gateway backend pools, and unnecessary operational overhead.

We wanted to avoid that.

---

While digging deeper, I noticed another security type option: `TrustedLaunchSupported`.

That was the turning point.

Here's what worked:

1. Created a temporary Image Definition with security type `TrustedLaunchSupported`.
2. Created an Image Version using the existing Managed Image (Standard) as source.
3. Updated the VMSS image reference to this temporary image.
4. Upgraded VMSS security type from `Standard` to `TrustedLaunch`.
5. Finally switched the VMSS image reference to the actual `TrustedLaunch` image definition.

And it worked.

No VMSS deletion.  
No additional downtime.  
No infra rewiring.

The key insight was that `TrustedLaunchSupported` acts as a bridge -- it allows compatibility during migration without enforcing Trusted Launch immediately.

---

### Quick Concepts

**Trusted Launch**: A VM security feature in Azure that enables Secure Boot, vTPM, and integrity monitoring to protect against boot-level attacks.

**Managed Images (Legacy)**: Older Azure image storage mechanism. Does not support Trusted Launch images.

**Azure Compute Gallery**: Modern image management solution with versioning, replication, and Trusted Launch support.

**Security Types**:

- `Standard` -- No Trusted Launch features
- `TrustedLaunchSupported` -- Compatible with both modes
- `TrustedLaunch` -- Trusted Launch enforced
