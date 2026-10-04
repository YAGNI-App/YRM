# YRM in five years

This document describes where YRM is going, not what it does today. Today it is a set of contracts and a plan for 0.1. The decisions behind the plan are in `docs/decisions/`; the design is in `docs/ARCHITECTURE.md`.

## One layer that every agent reads and writes

In five years an organization runs dozens of agents. One drafts replies, one prepares meetings, one watches renewals, one handles support escalations, one writes the weekly update for the board. Each of them needs to know the same things: who these people are, what was promised to them, what they objected to, what changed since last week. Today each agent rebuilds that picture from scratch out of a mailbox, a CRM export and whatever fits in a prompt, and each gets a slightly different answer.

YRM is the shared layer they read from and write to. When the meeting-prep agent reads that a customer's CFO raised a pricing objection on September 12th, it reads the same fact the renewal agent will read, with the same quote and the same link to the message it came from. When the support agent learns that the customer's main contact has left, it records that fact once and every other agent sees it. When a person corrects a fact, the correction holds for every agent and is never silently reverted by a model that re-read old mail.

The property that makes this work is provenance. Every fact names the event it came from, who said it, the exact words and how confident the extractor was. An agent can decide how much to trust a fact the way a careful person would: by checking the source.

## Time as a normal query parameter

"What did we know about Acme on June 3rd?" is a question every organization eventually needs answered: after a deal goes wrong or when an agent did something surprising. Most systems cannot answer it because they overwrote the old value.

In YRM it is a normal query. Facts carry the time they were true in the world and the time we believed them. An agent's decision log can record the `asOf` it read at, and anyone can replay that exact view later. This is the decision-trace idea applied to relationships: not only what the agent did, but what it knew when it did it.

## Commitments as objects with evidence

Most of what goes wrong in a relationship is a broken promise nobody tracked. "I'll send the security questionnaire by Friday." "We'll loop in procurement after the pilot." These live in mail threads and meeting notes and are forgotten.

In YRM a commitment is a first-class object: who owes it, to whom, by when, its status, and the event that fulfilled it. When a reply arrives with the questionnaire attached, the commitment closes and points at that reply as evidence. When Friday passes with no such event, it surfaces. An organization can ask what it owes every customer right now, and get a list where every line can be checked.

## Views instead of migrations

CRMs force a choice between a schema that fits nobody and a schema project that never ends. Adding a field means a migration, a backfill script and a form change.

In YRM a field is a sentence. "Economic buyer: the person who controls budget for this deal, usually visible from who approves pricing." The host reads that definition, backfills it from facts across the whole history, and keeps it current. A sales team, a recruiting team and an investor relations team can run on the same log with different views, and none of them file a ticket to add a column.

## Federation with consent

Two organizations working on a deal each hold half the picture. The buyer knows their approval steps; the seller knows what they promised.

Two YRM instances can exchange facts about a shared deal, under an explicit agreement scoped to that deal. The seller shares commitments it made and their status; the buyer shares the procurement steps and dates. Shared facts arrive as events in the receiving log, with the other organization as the source, so provenance and the human-beats-model rule apply unchanged. Either side can revoke, and revocation is itself recorded. Nothing outside the agreed scope crosses. This needs signed events and a consent protocol we have not designed yet; the event-log model is what makes it possible without merging databases.

## An attention queue you can argue with

Every morning YRM proposes what deserves attention: the unanswered ask from four days ago, the commitment due tomorrow, the champion who went quiet, the meeting on Thursday with two open objections. Each item says why, in terms a person can check, and links the facts and events it rests on.

The ranking is explainable because it is a function over the log. Rule rankers generate candidates, an optional model re-orders the top few and writes reasons, and both are extensions. If a team disagrees with the ranking, they change or replace the ranker, not file a feedback form.

## Local first, open-weight by default

Relationship data is some of the most sensitive data an organization holds. In five years open-weight models running on a laptop or a single server will handle triage and extraction well, and most of YRM's model work will never leave the machine it runs on. Hosted frontier models remain an option for the one daily synthesis call, routed by tier, with the user's own key and a hard budget.

A person can run YRM for their own mail with no account anywhere. An organization can run it on its own infrastructure. The same software runs in both places, and the data format is a log anyone can read.

## An ecosystem of packages

Most of YRM will not be written by us. Sources for every system that produces relationship events: mail, calendars, chat, call transcripts, support tickets, contract tools. Extractors for specific domains: enterprise procurement, venture fundraising, recruiting pipelines, clinical partnerships. Rankers tuned to how a particular team works. Each is a package with a manifest, loaded without a build step, using the same API as the built-ins. This is the pi model applied to a data system: a small core, hooks at every seam, packages as the unit of distribution.

## Why this is the right substrate

Agents are only as good as the context they act on, and an organization's context is mostly about people: what they want, what they said, what was agreed. The current pattern of each agent scraping its own context out of raw mail is expensive, inconsistent and unauditable. A shared, append-only, provenance-carrying layer is cheaper because understanding is paid for once per event, consistent because every agent reads the same facts, and auditable because every fact can be traced to its source and every past state can be replayed.

The CRM was built for people typing records into forms. YRM is built for a world where most of the reading and writing is done by agents and the person's job is to confirm, correct and decide.
