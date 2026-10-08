# STM-21: topic gate classifier benchmark

Final real run of `npm run eval:bench` (2026-10-07, 50 entries, all three classifiers, fallback threshold 0.9). The full per-entry JSON is in the gitignored `fixtures/eval/.runs/`. Jev was replaced before this ticket: it needs prepaid AI Gateway credits.

## What was measured

- **Embedding** (`worker/classifier/embedding.ts`): Workers AI `@cf/qwen/qwen3-embedding-0.6b`. Each sample (first/middle/last chunk, cut to 4,000 chars) is embedded as an instructed query; 9 software-engineering and 24 refusal label descriptions (`labels.ts`) as documents. Per sample: margin = best SE cosine − best refusal cosine. Source margin = mean over samples; ≥ 0 → accepted. Confidence = 0.5 + 0.5·min(1, |margin| / 0.1). `detected` = the refusal label with the highest mean similarity across samples.
- **Model** (`model.ts`): one `claude-haiku-4-5` call through AI Gateway, structured output `{verdict, confidence, detected}`, scope rules condensed from `fixtures/eval/README.md`, excerpts in `<excerpt>` tags marked as untrusted.
- **Fallback** (`fallback.ts`): embedding first; confidence < threshold → Haiku decides.
- Latency is inside the harness Worker (`scripts/classifier-harness`, local workerd, remote AI binding, 4 requests in parallel): it includes wrangler's remote-binding proxy for embeddings, so production should be faster. Not measured in production.
- Cost: Haiku from returned tokens at $1/$5 per million; embeddings estimated at $0.0118 per million tokens (chars / 4), since Workers AI reports no tokens.

## Honesty notes

- **No leakage.** Label descriptions were written from the README's accept/refuse rules and a generic topic list before looking at the manifest's entries or `detected` phrases; no eval text is used as a prototype. A unit test checks that no label contains an entry's title.
- **First try (before any change):** embedding 100% (44/44) unambiguous, 83.3% (5/6) ambiguous, 98% overall, detected match 87.5%; model 100% / 83.3% / 98%, detected 91.7%; fallback at 0.75: 100% / 83.3% / 98%, 2% to Haiku.
- **Iterations:** label descriptions changed **0 times**. One prompt change after the first run: Haiku's `detected` instruction gained "in plain everyday words (at most four words, no parentheses)", because it wrote "end-user software help (excel)". This only affects the phrase, and it is an in-sample fix; verdicts were unchanged.
- **Threshold:** the selection rule (highest unambiguous accuracy, ties to the lowest t) picks 0.5, i.e. never fall through, and leave-one-out cross-validation of that rule also scores 100% (44/44). Every threshold in the sweep scores 44/44, so **this set cannot choose the threshold**. 0.9 (|margin| < 0.08 → Haiku) is a judgement call, not a fit: the smallest unambiguous margins are 0.052–0.065, real uploads will be messier than a curated set, and a fall-through costs $0.003. On this set it sends 14% to Haiku for $0.47 per 1,000 sources.
- **Small set.** 44/44 has a one-sided 95% lower confidence bound of 93.4% (Clopper–Pearson), so the 90% gate is cleared but "100%" overstates it. The set is curated; the margin distribution says the embedding classifier is right by a clear margin on all but a few entries (Little Brother, Conway's law, Offside, a product-management paper).
- `detected` matching is a normalised comparison (lowercase, punctuation and leading article dropped) that accepts equality with the expected phrase or a synonym, or whole-word containment either way (`scripts/eval/metrics.ts`). It is strict: "excel spreadsheet tutorial" does not match "spreadsheets".

## Results

50 entries; fallback threshold 0.9. Accuracy: unambiguous (the 90% gate) / ambiguous (proposed labels) / overall.

| Classifier | Unambiguous | Ambiguous | Overall | Refused P | Refused R | Detected match | p50 | p95 | Tokens in/out | Embedded chars | $/source | $/1k sources | → Haiku |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| embedding | 100.0% (44/44) | 83.3% (5/6) | 98.0% (49/50) | 100.0% | 100.0% | 87.5% (21/24) | 1646 ms | 5169 ms | 0/0 | 610774 | $0.00004 | $0.0360 | 0% |
| model | 100.0% (44/44) | 83.3% (5/6) | 98.0% (49/50) | 100.0% | 100.0% | 91.7% (22/24) | 1607 ms | 2029 ms | 153674/1113 | 0 | $0.00318 | $3.1848 | 100% |
| fallback | 100.0% (44/44) | 83.3% (5/6) | 98.0% (49/50) | 100.0% | 100.0% | 91.7% (22/24) | 2793 ms | 8656 ms | 20938/159 | 610774 | $0.00047 | $0.4707 | 14.0% (7) |

Refused P/R are on the unambiguous entries, refused = positive. Detected match: refused entries predicted refused whose phrase matches the expected one or a synonym (scripts/eval/metrics.ts `detectedMatches`).

## Confusion (unambiguous entries)

| Classifier | refused→refused | accepted→refused (blocked) | refused→accepted (let through) | accepted→accepted | errors |
|---|---|---|---|---|---|
| embedding | 22 | 0 | 0 | 22 | 0 |
| model | 22 | 0 | 0 | 22 | 0 |
| fallback | 22 | 0 | 0 | 22 | 0 |

## Ambiguous entries (proposed labels, awaiting a ruling)

| Entry | Proposed | embedding | model | fallback |
|---|---|---|---|---|
| se-pdf-cisa-secure-by-design | accepted | accepted 1.00 | accepted 0.98 | accepted 1.00 |
| se-article-google-rules-of-ml | accepted | accepted 0.57 | accepted 0.95 | accepted 0.95 (via model) |
| se-article-wiki-etl | accepted | accepted 1.00 | accepted 0.95 | accepted 1.00 |
| off-pdf-nist-csf | refused | accepted 0.89 | refused 0.95 "cybersecurity risk management" | refused 0.95 "cybersecurity risk management" (via model) |
| off-article-wiki-eniac | refused | refused 0.90 "computer hardware" | refused 0.95 "computer history" | refused 0.90 "computer hardware" |
| off-article-wiki-scrum | refused | refused 0.87 "product management" | accepted 0.95 | accepted 0.95 (via model) |

## Fallback threshold sweep (simulated from the embedding and model runs)

Embedding confidence ≥ t keeps the embedding verdict; below t the model's verdict is used. Confidence = 0.5 + 0.5·min(1, |margin| / 0.1); t = 0.5 never falls through, 1.01 always does.

| t | Unambiguous | Ambiguous | Overall | → Haiku | $/source |
|---|---|---|---|---|---|
| 0.5 ◀ | 100.0% (44/44) | 83.3% (5/6) | 98.0% (49/50) | 0.0% | $0.00004 |
| 0.525 | 100.0% (44/44) | 83.3% (5/6) | 98.0% (49/50) | 0.0% | $0.00004 |
| 0.55 | 100.0% (44/44) | 83.3% (5/6) | 98.0% (49/50) | 0.0% | $0.00004 |
| 0.575 | 100.0% (44/44) | 83.3% (5/6) | 98.0% (49/50) | 2.0% | $0.00007 |
| 0.6 | 100.0% (44/44) | 83.3% (5/6) | 98.0% (49/50) | 2.0% | $0.00007 |
| 0.625 | 100.0% (44/44) | 83.3% (5/6) | 98.0% (49/50) | 2.0% | $0.00007 |
| 0.65 | 100.0% (44/44) | 83.3% (5/6) | 98.0% (49/50) | 2.0% | $0.00007 |
| 0.675 | 100.0% (44/44) | 83.3% (5/6) | 98.0% (49/50) | 2.0% | $0.00007 |
| 0.7 | 100.0% (44/44) | 83.3% (5/6) | 98.0% (49/50) | 2.0% | $0.00007 |
| 0.725 | 100.0% (44/44) | 83.3% (5/6) | 98.0% (49/50) | 2.0% | $0.00007 |
| 0.75 | 100.0% (44/44) | 83.3% (5/6) | 98.0% (49/50) | 2.0% | $0.00007 |
| 0.775 | 100.0% (44/44) | 83.3% (5/6) | 98.0% (49/50) | 4.0% | $0.00014 |
| 0.8 | 100.0% (44/44) | 83.3% (5/6) | 98.0% (49/50) | 6.0% | $0.00021 |
| 0.825 | 100.0% (44/44) | 83.3% (5/6) | 98.0% (49/50) | 8.0% | $0.00025 |
| 0.85 | 100.0% (44/44) | 83.3% (5/6) | 98.0% (49/50) | 8.0% | $0.00025 |
| 0.875 | 100.0% (44/44) | 66.7% (4/6) | 96.0% (48/50) | 12.0% | $0.00041 |
| 0.9 | 100.0% (44/44) | 83.3% (5/6) | 98.0% (49/50) | 14.0% | $0.00047 |
| 0.925 | 100.0% (44/44) | 83.3% (5/6) | 98.0% (49/50) | 16.0% | $0.00054 |
| 0.95 | 100.0% (44/44) | 83.3% (5/6) | 98.0% (49/50) | 22.0% | $0.00073 |
| 0.975 | 100.0% (44/44) | 83.3% (5/6) | 98.0% (49/50) | 24.0% | $0.00084 |
| 1 | 100.0% (44/44) | 83.3% (5/6) | 98.0% (49/50) | 24.0% | $0.00084 |
| 1.01 | 100.0% (44/44) | 83.3% (5/6) | 98.0% (49/50) | 100.0% | $0.00322 |

Chosen by the rule "highest unambiguous accuracy, ties to the lowest t": **t = 0.5**, in-sample 100.0% (44/44) unambiguous, 0.0% to Haiku.
Leave-one-out (choose t on the other 43 unambiguous entries, score the held-out one, ×44): **100.0% (44/44)** unambiguous; thresholds chosen across folds: 0.5.
Every threshold gives the same unambiguous accuracy, so this set cannot choose the threshold; the rule then falls to its tie-break.
Smallest |margin| among unambiguous entries: off-article-doctorow-little-brother -0.052, se-article-wiki-conways-law 0.058, off-article-wiki-offside -0.065.

## Misses

### embedding (1)

| Entry | Label | Ambiguous | Predicted | Confidence | Detected | Margin | Decided by |
|---|---|---|---|---|---|---|---|
| off-pdf-nist-csf | refused | yes | accepted | 0.89 |  | 0.078 | embedding |

### model (1)

| Entry | Label | Ambiguous | Predicted | Confidence | Detected | Margin | Decided by |
|---|---|---|---|---|---|---|---|
| off-article-wiki-scrum | refused | yes | accepted | 0.95 |  |  | model |

### fallback (1)

| Entry | Label | Ambiguous | Predicted | Confidence | Detected | Margin | Decided by |
|---|---|---|---|---|---|---|---|
| off-article-wiki-scrum | refused | yes | accepted | 0.95 |  | -0.074 | model |

## Detected phrases that did not match

- **embedding**: off-article-gutenberg-gift-of-the-magi said "personal finance" (expected "fiction"); off-article-doctorow-little-brother said "law and politics" (expected "fiction"); off-youtube-crashcourse-agriculture said "cooking" (expected "history")
- **model**: off-article-ms-excel-formulas said "help with end-user software" (expected "spreadsheet help"); off-youtube-excel-vlookup said "excel spreadsheet tutorial" (expected "spreadsheet help")
- **fallback**: off-article-gutenberg-gift-of-the-magi said "personal finance" (expected "fiction"); off-youtube-crashcourse-agriculture said "cooking" (expected "history")
