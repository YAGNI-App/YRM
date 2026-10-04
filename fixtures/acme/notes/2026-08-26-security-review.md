---
date: 2026-08-26
title: Acme Robotics security review
attendees:
  - jack@yagni.example
  - dana@yagni.example
  - elena.vasquez@acme-robotics.example
  - marcus.bell@acme-robotics.example
  - tom.fischer@acme-robotics.example
event: acme-security-review-20260826@yagni.example
---

# Acme Robotics security review

One hour, led by Elena. First meeting since Priya left; Marcus said little and let Elena run it.

## What went well

- Elena had read the Type I report and the pen test summary closely and had no findings on either.
- Dana's walkthrough of the proxy setup and on-site storage landed well. Tom said the data flows were "simpler than the AMR vendor's".

## The objection

Elena was clear: Acme policy requires SOC 2 Type II for anything on a network segment adjacent to production, and she will not sign an exception. Type I is not enough. She called it a hard blocker, not a preference. Marcus did not push back in the meeting.

The test VLAN install Tom promised for August 14 never happened because of the change freeze, so we have no shadow data to soften this.

## Commitments

- I will send Elena and Marcus our SOC 2 Type II report by September 30.
- Dana will send the subprocessor list and agent data-flow diagram by September 4.

## Next steps

- Written recap to Elena and Marcus tomorrow; propose mid-October start if Type II lands on time.
- Ask our auditor for a bridge letter as a fallback in case the report slips.
- Keep Marcus warm. With Priya gone there is nobody inside Acme pushing for this.
