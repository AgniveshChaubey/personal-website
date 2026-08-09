+++
date = '2026-05-10T14:04:57Z'
draft = false
title = 'Azure Front Door Quirks'

tags = [ "azure", "azure-front-door", "azure-application-gateway", "azure-blob-storage", "cdn", "url-rewrite", "routing", "cloud-engineering", "production-issues", "debugging", "networking", "performance-optimization" ]

categories = [ "Azure", "Cloud Engineering", "DevOps" ]
+++

Recently faced some unusual behaviour during Azure Front Door setup for my client's application -- so thought to write it down for my future reference and make it easier for others if they're stuck in a similar sort of issue.

A bit of context... We have a web app that's hosted on Azure VMSS (Virtual Machine Scale Set) and exposed via Azure Application Gateway. To improve the performance of the application, we decided to put a CDN layer in front of it to enable caching and reduce latency for static content.

Our application requires both static and dynamic data. Static data/assets are stored in Azure Blob Storage and data is served from MySQL databases. The setup was as follows:

- All data requests (both static and dynamic) arrive at Application Gateway
- AGW routes the static requests to the concerned backend microservice, which fetches data/assets from Azure Blob Storage
- Microservice sends back the data to AGW, and AGW then forwards the response back to the client

Now, since we wanted to introduce a CDN layer, we thought why not bypass the Application Gateway for static content stored in Blob Storage and send requests directly to Blob Storage. This way, we can save two additional hops (FD to AGW and then AGW to backend microservice), which can significantly reduce latency.

Great! Let's start the setup.

- Created an Azure Front Door Standard Tier (because Premium tier is a bit costly -- but this Standard tier resulted in some bottlenecks which are discussed later)
- Created an Endpoint
- Created two Origin Groups -- one for Application Gateway and another for Azure Storage Account
- Created a Route that matches `/data/*`
- Created another Route that matches `/*`

An important point to note is that previously, public access was restricted on the Storage Account. But since Azure Front Door Standard tier does not support connecting to Storage Account using private link (this feature is supported only in Premium tier), we had to allow public access to blobs at the Storage Account level and update the access level to `BLOB` so that the content can be accessible only if the request is made to the exact path in the storage account.

There's some specific behaviour we wanted -- that is, only serve public static content directly via Storage Account (in our case those were image files), and route all other requests for private static content to AGW (AGW will do the validation and check if the user is allowed to access the private data).

Keep in mind this setup is not yet production ready (and we're still figuring out different solutions), because if someone somehow gets the name of the Storage Account and exact path of private files in Blob Storage, then they can access those files.

To tackle this, we have two options:

- Either upgrade the tier to Premium (so that Storage Account public access can be disabled and blob content can be accessed via private endpoint)
- Or use some sort of Azure authentication

I'll cover this in the next blog -- let's keep this one focused on the rewrite issue.

So, we wanted the following three behaviours when requests arrive at Front Door:

1. Requests coming at `/*` should go to AGW Origin
2. Requests coming at `/data/*` should go to Storage Account Origin if the requested resource is an image
3. Requests coming at `/data/*` should go to AGW Origin if the requested resource is anything other than images

Configuring the first route was pretty straightforward since we just needed to forward `/*` requests directly to AGW Origin without any rewrite. This was easily handled in the route itself. We didn't need to attach any rule to it.

Complexity arrived when I tried to implement the route that matched `/data/*` path.

The Blob container name isn't included in the URL path, but while sending requests to Storage Account, we needed to include the blob container name in the URL path as a prefix. So, we added a URL Rewrite rule as follows:

- Route is configured to match `/data/*`
- Rule: URL Rewrite
  - Condition -- Pattern to match: `/data/*` and file extension is `.jpg`, `.png`, etc
  - Action -- Source Pattern: `/data/` | Destination Pattern: `/<blob-container-name>/data/`

The real game starts here.

For example, for this path (`/data/images/abc.jpg`), we expected the request to go to `/<blob-container-name>/data/images/abc.jpg`.

But after investigating the logs, we found that the request was going to `/data/images/abc.jpg` (no rewrite happened).

That's strange -- the rule looks pretty fine... but why no rewrite?

Turned out, in the context of a [URL rewrite action](https://learn.microsoft.com/en-us/azure/frontdoor/front-door-url-rewrite?pivots=front-door-standard-premium#source-pattern), only the path after the route match pattern is taken into consideration for the source pattern.

So in our case, the current rule was never getting evaluated properly because the route already matched `/data/*`.

Now, when it proceeded for rule evaluation, the source pattern was expecting to match `/data/`, but in reality, only `/images/abc.jpg` reached the rewrite rule.

So the source pattern never matched, and hence the rewrite never happened.

During route setup, there's an option to set `Origin path` (which rewrites the matched segment of the route).

So in this case, we just needed to set the `Origin path` of the route configuration to `/` and update `Source Pattern` to `/` (instead of `/data/`), and there we go -- it worked.

But since we also needed to forward private static files to Application Gateway, the `Origin path` rewrite created another issue here.

For example, the incoming request to `/data/config/abc.json` should be forwarded to AGW Origin. But instead, it was forwarded to `/config/abc.json`.

Huh! Another issue.

But this one was pretty easy to fix.

We simply added two actions to the forwarding condition. This is as follows:

- Route is configured to match `/data/*`
- Rule: URL Rewrite and Origin Group Override
  - Condition -- Pattern to match: `/data/*` and file extension is NOT `.jpg`, `.png`, etc
  - Action 1 -- Source Pattern: `/` | Destination Pattern: `/data/`
  - Action 2 -- `Origin Group Override` set to `AGW Origin`

Fwww! Finally it's done.

Now all three conditions are working properly.

But one important thing to note is that this setup is still not production ready because of the security-related issue mentioned above. That will either be tackled by adding some sort of authentication or by upgrading Azure Front Door tier to Premium.

I'll share that in a follow-up blog.

Hope you enjoyed it. Thanks.