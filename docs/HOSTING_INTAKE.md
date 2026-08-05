# Hosting intake — questions for UWC IT

The fleet system currently runs on a cloud host (Railway) with a managed
PostgreSQL database and Cloudinary for photo storage. UWC has asked about moving
it onto UWC infrastructure.

The answers below decide whether that is a small change or a large one, so they
are worth settling before any work starts. The full deployment detail is in
`SELF_HOSTING.md`; this page is just the questions.

**Scale, for context:** roughly 6–8 drivers, a handful of office staff, trip
volume in the tens per day. This is a small deployment — one application server
and one database. It is not an enterprise rollout.

---

## The questions

**1. What can host a long-running application?**
A Linux VM, a container platform, a Windows Server, space in a UWC-owned cloud
subscription — or is the server in question file storage only?
*Why:* the application is a Node.js process that must stay running. It is not a
website that can be dropped onto a file share.

**2. Node.js 20 and PostgreSQL 16 — can you provide both?**
Either installed directly, or as containers, or PostgreSQL as a managed service.
*Why:* these are the two tested versions. Others may work but are unverified.

**3. Is there a public HTTPS entry point, and who manages it?**
Drivers use the system from their phones on mobile data, outside the UWC
network. The application must be reachable from the public internet. Who issues
the TLS certificate and manages the DNS name?
*Why:* an internal-only deployment cannot serve drivers in the field. This is
the single most important answer on this page.

**4. Storage: object storage or a file share?**
If UWC storage is to hold delivery photos and documents, we need to know whether
it is S3-compatible object storage (MinIO, Ceph, NetApp StorageGRID, Dell ECS,
Azure Blob, AWS S3) or a conventional file share (SMB/NFS/NAS). And: is it
reachable from outside the UWC network over HTTPS?
*Why:* photos are written by an application that may sit outside the network and
read back by phones in the field. Both directions need reachability, and private
photos need expiring signed links — a capability object storage has and a file
share does not.

**5. Backups — what would you like us to use?**
A nightly database dump needs somewhere to land. This one is easy: any UWC
storage works, including a plain file share, and it does not depend on the
answers above.

**6. Who operates it after handover?**
Restarts, backups, certificate renewal, applying updates. Please also name a
single technical contact for this work.

**7. Device policy — can drivers install the Android app?**
We understand app installation may be restricted. There is a browser version
that needs no installation and works on Android and iPhone.
*Why:* it changes what we deliver, and one feature depends on the answer — see
the note below.

> ### ⚠ Worth raising early, on question 7
>
> Background location tracking — the map showing where trucks are during a trip —
> works only in the installed Android app. A phone browser cannot track location
> when the browser is in the background; that is a limitation of browsers, not of
> this system.
>
> So if drivers are browser-only, live truck tracking is lost. Everything else
> (jobs, delivery confirmation, photo capture, paperwork) works fine in the
> browser. This is a decision for UWC, but it should be a deliberate one.

---

## What each answer means

| Answer to Q1 | What it means |
|---|---|
| Linux VM or container platform | Standard case. `SELF_HOSTING.md` applies as written. |
| UWC-owned cloud subscription (Azure/AWS/GCP) | **Often the easiest option** — see the note below. |
| Windows Server only | Workable (Node and PostgreSQL both run on Windows) but off the tested path. Expect extra setup time. |
| Shared/cPanel-style hosting | Poor fit. The application runs scheduled background jobs and needs a persistent process. |
| File storage only | The application cannot move. Backups still can, and photos might — see Q4. |

| Answer to Q4 | What it means |
|---|---|
| S3-compatible object storage, internet-reachable | Photos can move. Contained change, one component. |
| S3-compatible but internal-only | Photos can move **only if** the application also moves inside the network — and then Q3 must still be solved for drivers. |
| File share (SMB/NFS/NAS) | Backups yes. Photos only with additional work and worse performance, and only if the application can reach it. |
| Internal-only, no external access | Photos stay where they are. Not a failure — just a constraint. |

> ### A UWC-owned cloud subscription may be the best answer
>
> If the goal is "UWC's data on UWC's infrastructure, under UWC's control," a UWC
> cloud account satisfies that as fully as a physical server does — the account,
> the data and the access policy are all UWC's. It also tends to be **less** work
> than an on-premise box: managed PostgreSQL, S3-compatible storage that solves
> the photo question, TLS and DNS handled, and backups built in.
>
> If UWC already has an Azure or AWS tenancy, it is worth putting on the table
> before committing to on-premise hardware.

---

## What we are not asking for

To keep the scope clear: no inbound access to UWC's internal network, no
integration with existing UWC systems, no domain accounts, and no changes to
device management beyond the question in Q7.
