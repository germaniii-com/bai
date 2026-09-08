---
description: "Research the live web: search, fetch, and cite sources."
version: 1.0.0
author: bai
tags: [Research, Web, Search, Citations]
---

# Web Research

A disciplined search-then-read workflow for questions whose answers depend on current, niche, or contested information. Uses `web.search` to find candidates and `web.fetch` to read the promising ones in full, then answers with named sources.

This skill covers method, not tool flags — the tools' own schemas describe their parameters.

## When to Use

- The answer could be stale, niche, or contested (pricing, releases, API changes, news, opinions).
- The user asks to "look it up", "find out", or "check the latest".
- You are about to state a specific number, date, or version you cannot verify from training knowledge.

Do NOT use it for stable knowledge you already hold (language semantics, well-known algorithms) — search adds latency without adding truth.

## Prerequisites

- `web.search` and `web.fetch` available in your tool set.
- No API keys needed for the default provider.

## How to Run

1. Decompose the question into 1-3 precise queries — specific beats broad ("arxiv API max_results limit" beats "arxiv API").
2. `web.search` the first query; scan titles/snippets for candidates that plausibly contain the answer.
3. `web.fetch` the 1-2 most promising results and read them fully.
4. Answer from what you read; cite each load-bearing claim with its site or URL.
5. If the fetches don't answer it, refine the query (different terms, site-scoped) and repeat — twice max, then say what you could and could not confirm.

## Quick Reference

- Search: `web.search` — ranked results (title, url, snippet).
- Read: `web.fetch` — full page text of one URL.
- Cite: name the site or URL next to the claim it supports.
- Give up gracefully: state what you verified, what you could not, and what you'd check next.

## Procedure

1. **Frame the question**: what exactly must be true to answer it? What would a source containing the answer look like?
2. **Search**: start specific. If results are poor, broaden once, then change vocabulary rather than repeating the same terms.
3. **Triage**: prefer primary sources (official docs, the project's own changelog, standards bodies) over aggregators and SEO content. Snippets are previews, not evidence.
4. **Fetch and read**: read the fetched text before citing it — a snippet that "looks right" is not an answer.
5. **Synthesize**: lead with the answer, then the reasoning. Mark uncertainty explicitly ("as of the docs fetched above…").
6. **Cite**: every non-trivial claim gets its source inline. Multiple sources for contested claims.

## Pitfalls

- Snippets are not answers — fetch before you cite.
- One source is not consensus for contested facts; find a second or flag the uncertainty.
- Old pages rank well; check dates on anything time-sensitive.
- Do not fetch the same domain repeatedly hoping for different content — change the query instead.
- If a fetch returns boilerplate/cookie walls, try the site's docs subpath or a different source rather than forcing it.

## Verification

Every load-bearing claim in the final answer has an inline source; anything unverified is labeled as such.
