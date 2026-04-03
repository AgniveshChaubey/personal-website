+++
date = '2026-04-03T18:04:36Z'
draft = false
title = 'The Cache That Wasnt the Problem: A Production Debugging Story'

tags = [ "redis", "caching", "cache-invalidation", "in-memory-cache", "microservices", "distributed-systems", "debugging", "production-issues", "system-design", "backend-engineering" ]
categories = [ "Backend Engineering", "System Design", "Distributed Systems", "Debugging" ]

description = ""
+++

Caching bugs are tricky. The worst part? Sometimes… caching isn't even the real problem.

We recently ran into an issue in production that looked exactly like a cache invalidation problem, but turned out to be something much more subtle.

Our system follows a fairly standard microservices setup. Different users have different access permissions, and route-level access is stored in a database. On service startup, this data is fetched and cached in Redis for performance. We also have a feature management system backed by MongoDB.

Whenever a new route is added or permissions change, we manually trigger an API to clear Redis so that fresh data can be loaded.

Now we rolled out a new feature: third-party authentication. There was one catch - due to a temporary workaround, it required manually inserting a document in MongoDB to enable the feature.

The deployment went as expected. The new build was released, the service started, and it fetched and cached the latest data. After that, we inserted the required document in MongoDB, cleared the Redis cache, and tested the feature.

It didn't work.

At this point, everything looked correct. The feature had already been tested by another team, the MongoDB document was present, and Redis had been cleared. Still, the system behaved as if the feature didn't exist.

We started going through the usual debugging checklist - cache invalidation, Redis state, database reads, possible race conditions. Nothing stood out. For a while, it genuinely felt like one of those "ghost bugs".

The actual issue turned out to be much simpler, and at the same time, easy to overlook.

The service was caching the feature configuration in memory during startup.

So even though MongoDB had the updated document and Redis was cleared, the service was still using stale data that had been loaded into memory when the container first started.

A simplified version of the pattern looked like this:

```js
let featureConfigCache = null;

const loadFeatureConfig = async () => {
  const data = await db.collection("featureFlags").find({}).toArray();
  featureConfigCache = data;
};

loadFeatureConfig();

const isFeatureEnabled = (featureName) => {
  if (!featureConfigCache) {
    throw new Error("Feature config not loaded yet");
  }

  return featureConfigCache.some((f) => f.name === featureName && f.enabled);
};
```

The problem here is subtle. The data is fetched once, stored in a global variable, and never refreshed. Any updates to the database or Redis simply don't matter after that point.

The immediate fix was straightforward -- we restarted the container. On restart, the service fetched fresh data into memory and the feature started working as expected.

But the real takeaway was about design.

If data can change at runtime, loading it once at startup is risky. In-memory caching like this can silently override all other layers, including Redis, and make debugging unnecessarily confusing.

A better approach is to introduce a refresh mechanism, either through a TTL-based strategy or by relying more consistently on Redis as the single source of truth.

For example:

```js
let featureConfigCache = null;
let lastFetched = 0;
const TTL = 5 * 60 * 1000;

const getFeatureConfig = async () => {
  const now = Date.now();

  if (!featureConfigCache || now - lastFetched > TTL) {
    featureConfigCache = await db.collection("featureFlags").find({}).toArray();

    lastFetched = now;
  }

  return featureConfigCache;
};
```

This incident was a good reminder that not all cache issues are actually about Redis. When multiple caching layers are involved, the real problem might be hiding in plain sight.

In our case, it wasn't cache invalidation that failed; it was an assumption that the data would never change after startup.

And that's what made it interesting.
