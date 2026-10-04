# The Acme Robotics pilot

Everything here is fictional. Every company, person, phone number and domain is invented, and every domain uses the reserved `.example` TLD.

## Cast

| Key | Person | Role | Addresses |
|---|---|---|---|
| jack | Jack Collins | Founder, YAGNI (the tenant) | jack@yagni.example |
| dana | Dana Okafor | Solutions Engineer, YAGNI | dana@yagni.example |
| priya | Priya Raman | Director of Fulfillment Ops, Acme, later Director of Solutions, Northwind (champion) | priya.raman@acme-robotics.example, priya@northwind.example |
| marcus | Marcus Bell | VP Operations, Acme (economic buyer) | marcus.bell@acme-robotics.example |
| elena | Elena Vasquez | Head of Information Security, Acme | elena.vasquez@acme-robotics.example |
| tom | Tom Fischer | Senior Operations Engineer, Acme | tom.fischer@acme-robotics.example, tfischer@mailhub.example |
| rachel | Rachel Kim | Procurement Manager, Acme | rachel.kim@acme-robotics.example |
| sam | Sam Lindqvist | Partner Lead, Northwind Automation | sam@northwind.example |

Organizations: **YAGNI** (`yagni.example`), **Acme Robotics** (`acme-robotics.example`), **Northwind Automation** (`northwind.example`), a Fulcrum WMS integrator that partners with YAGNI. `mailhub.example` is a freemail provider.

## The story

**June: a warm intro.** Priya Raman runs fulfillment at Acme's Reno distribution centre and has wanted better wave planning since last peak. On June 2 she introduces Jack to her boss, Marcus Bell, who owns the budget for all three of Acme's DCs. Jack promises a one-pager and pricing by Friday June 5, and delivers on time, answering Marcus's two questions (three-site pricing, native Fulcrum integration) in the same mail. Priya books a discovery call for June 16 and adds Tom Fischer, the engineer who owns Fulcrum at Reno.

After the call Jack writes it up in a note and sends a recap with two commitments: Priya will send two weeks of pick data by June 23, and Jack will send a pilot proposal by June 26. Both are kept. In between, Tom writes from his personal `mailhub.example` address because Acme's new mail gateway is stripping attachments. Jack answers and copies Tom's work address, so the same person now appears under two addresses.

**July: a decision, then an objection.** Marcus asks what happens to Acme's data if they stop after the pilot, and Jack answers in one sentence. At the July 8 scoping meeting Marcus chooses Option A: Reno only, 8 weeks, 40 pickers, starting August 24. He confirms it in writing the next day and promises the order form back from procurement by July 17. Rachel Kim delivers on time and asks whether YAGNI accepts net 60. Jack says yes. Jack also lines up Sam Lindqvist at Northwind for install week.

On July 14 Elena Vasquez, Acme's head of security, raises the objection that drives the rest of the story: YAGNI holds SOC 2 Type I, and Acme policy requires Type II for anything near the production network. Jack promises the Type I report and pen test summary by July 24 and sends them a day early.

**August: things slip.** Tom promises to install the agent on a test VLAN by August 14. He doesn't: a corporate change freeze blocks it, and he says so on August 18. That is the broken commitment. On August 14, Priya's last day at Acme, she emails Jack to say she is leaving for Northwind. Acme's data-loss-prevention gateway quarantines the message for mentioning her new employer, and it reaches Jack only on September 3. The job change was true from August 14, but nobody on YAGNI's side knew until September.

At the August 26 security review Elena calls Type II a hard blocker. Jack commits to deliver the Type II report by September 30, and Dana commits to a subprocessor list and data-flow diagram by September 4. On August 28 Elena puts the whole pilot on hold.

**September: silence.** Dana delivers early. On September 2 Marcus emails Jack privately. He needs a yes or no for his CFO: if Type II slips, can Acme exit with no fee? He also asks Jack to cancel the September 15 kickoff. Jack cancels the meeting but never answers the question. After that, nobody at Acme writes again. Sam tells Jack that Priya now works at Northwind, and Priya writes from her new address, explains the quarantined email, and warns that Elena is not bluffing. Jack's September 22 check-in to Marcus and Elena gets no reply, and it still doesn't answer Marcus.

**October 3.** Dana tells Jack the auditor has slipped the Type II report to October 16. So on the morning of October 3, `yrm today` should say:

1. **Marcus asked you a yes/no question on September 2 and you never answered.** That is the reason he is quiet.
2. **Your promise to Elena (Type II by September 30) is overdue.** Dana has a bridge letter ready.
3. **Acme Robotics has gone quiet for 31 days.**

The path back runs through Priya, who now works at Northwind and still knows everyone at Acme.
