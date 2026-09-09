# PR14 — collector correctness 與 evidence completeness

結論分開：既有封包的保存及 provenance 對帳成立；公開工具的原 60 個測試通過，但本輪補充反例重現兩個完整性缺陷。原 PR14 因而不能被本報告宣稱為完整正確；修正另在 [Draft PR15](https://github.com/danny0971haha/multi-venue-grid-engine/pull/15)，待獨立 reviewer。這不抹去封包已觀測到的規則。

## 真實執行版本

| 身分 | commit | tree | 本輪解讀 |
|---|---|---|---|
| acquisition | `9b13a7fd3c0d7b354d6a5bf8ceefab4c838d112b` | `92420dbc44da482c3328fad10658018128f38f26` | 2026-09-08 17:37:48–17:38:25 UTC，67 responses；原 command 最後 scan exit 1 |
| offline repack | `43e9a371492bf807db23b3046824807c52beeefe` | `d4954aa9348d0886948fa3ac8857900af9f04acf` | 原 acquisition 離線重新封裝；零新網路 requests；兩筆已記錄 mask |
| 原 final tool checkpoint | `cc7614195661ffb18da44d9c5ba6e31c100281b2` | `16000a1c6a643862fd1bb077c62053f6731cc1e3` | tool subtree=`171f65447e9413f60e461abe0bc2bd04d7b44461` |
| 原 published PR14 head | `12d04d82d0a2b02240619633b3264c77eb1754c9` | `1b176e67b4a398450f26bbf1544ebb7757846dcb` | tool subtree 與 final checkpoint 相同；本輪在這組 bytes 重跑 60/60 |
| 本輪新 tool checkpoint | `2f71dd048f49a3218c55cf9876363ccd8741ea1a` | `24bf08e926ae77d79a6e5ce06c782dbab5e6e55f` | 只修兩個重現反例；63/63 |
| 本輪 published PR15 head | `26e19416585d173ac1ba3b53d338c52c646f983f` | `b91528e8626f13b38d0b1f5f69a3df61d937a7a9` | 公開後 exact-head 重跑 63/63；tool subtree=`4ad772c4948f0da07a77d64be83224dcfef4aff4` |

PR14 corrective base=`b2ea605d5ed507b634f9a2ee5907db39bf129d13`，PR base=`22665d7fa9274dfc05de043c8e9663e24e75087e`。PR15 stack base 為上述 PR14 published head。兩個 PR14 以後的測試結果只屬於對應 tool bytes，沒有倒灌 acquisition。

## 既有封包驗證

先讀公開的 [EVIDENCE](https://github.com/danny0971haha/multi-venue-grid-engine/blob/12d04d82d0a2b02240619633b3264c77eb1754c9/docs/evidence/protection-v2-corrective-20260909/EVIDENCE.md)、同目錄 CORRECTIONS、API-CONTRACT、packaging-note、collection-command 與 repack-command-output，再使用現有 archive 離線核對，沒有完整重新蒐集 GitHub protection。

[原封包 archive](https://github.com/danny0971haha/multi-venue-grid-engine/blob/12d04d82d0a2b02240619633b3264c77eb1754c9/docs/evidence/protection-v2-corrective-20260909/collection-repacked.tar.gz) SHA256=`2706e664f55a596357fb5a4ee92d947e2d6029d9d0f27197bafaf3ef4739c6f2`，吻合交付值。解壓後 145/145 SHA256SUMS rows 相符；request ledger 67/67 body hashes 相符；48/48 acquisition source-file hashes 與該 acquisition commit Git objects 相符。repack sanitizer hash 亦與 packaging commit bytes 相符。

本機原失敗 packet 實際存在；provenance 中 144/144 original-files hashes 對得上。遮罩只涉及 `raw/0012.body` 與 `raw/0062.body`：兩者原 SHA256 均為 `16ef89167d4ae9ec543d1fa29fc894072ab3aaacbc0ae50351fa07df36e9c3f7`，封裝後均為 `dda109d685b40064a53d4974f038c7d0b0339ecc17442f4472e31ab13b980a8d`；原／新實際 bytes 都驗證。derived/analysis、identity、sources、coverage 的內容 hash 沒有因 repack 改變。

[provenance audit](attachments/pr14-provenance-audit.json) 與 [145 檔清單](attachments/pr14-packet-hashes.json) 保留逐項結果。原 acquisition command exit=1／traceback 仍在 PR14 已公開 `collection-command.json`；repack 的封裝完成不把該 attempt 改成 exit 0。packet 的 `LIVE_COLLECTION=COMPLETE` 只描述已取得 sources 的分析分類；`TOOL_TESTS=NOT_RECORDED_IN_PACKET` 也保留，不填入後來的測試。

Ledger 是 66 REST GET 與 1 GraphQL query over POST。transport 的 method guard／query guard 仍存在，原 test_safety 與 mock subprocess 測試已重跑；不因 POST 便誤稱 mutation，也不因 endpoint-required headers 便推定 caller grant。

## 原 60 個測試與新反例

| 驗證重點 | 實際原候選 bytes／測試位置 | 本輪結果 |
|---|---|---|
| observed ref 先解析、同 SHA tree、expected 不充當 observed | `lib/collect.py:capture_identity/compare_identity`；`test_corrective.py:test_main_ref_mismatch_before_not_hidden_by_existing_expected_commit`、`test_observed_pr_head_tree_come_from_same_sha` | 通過；錯誤／移動 identity 不能建立 completeness |
| REST/GraphQL missing/null、partial、interrupt、cursor、duplicate/count | `lib/validation.py`、`paginate_rest_list`、`collect_branch_protection_rules`；test_corrective pagination/shape cases、test_pagination | 原案例通過；另找到 REST skipped numbered page，見下 |
| 權限、positive observation + UNKNOWN、org/enterprise snapshot applicability | `lib/analyze.py`；endpoint-permission、product-nonapplicability 及 coverage tests | 通過；admin before/after + GraphQL ADMIN 與 endpoint requirement 分開；NA 要求 User-owned non-fork 的同次 snapshot 證據 |
| before/after main、PR head/base、frozen ref 移動 | `test_identity_midrun_moves_main_pr_base_and_each_frozen_ref` | 通過，coverage PARTIAL／identity_verified=false |
| redaction、原結果保存與封包 | test_redact、test_collect_offline、現有 repack provenance | 60-suite 通過；實際封包 hash 鏈另核對，沒有重新 acquisition |
| query-only／GET-only、schema resetAt | test_safety、test_schema_contract、test_corrective real-transport mock tests | 通過；schema 測試綁原已保存官方 schema 日期，非未來 API 保證 |

[原公開 HEAD 60/60 原輸出](attachments/pr14-python-tests.log.stderr)，Python 3.13.14、2026-09-09 06:16:16 UTC。普通 CI `34259520400` 是 pull_request success，其工作流只跑 Phase 0 檢查；不是這 60 個 Python 測試，也不是治理接受。

兩個本輪可重現缺陷（皆為 P2 完整性誤判）：

1. `enforce_admins={}` 或 enabled missing/null/字串/數字可被當作 HTTP-200 完整 classic 觀測，整體甚至 `COMPLETE_FOR_APPLICABLE_SOURCES`。最小修正要求 enabled 是實際 boolean；false 與 true 均可保留為觀測，缺漏保持 PARTIAL，confirmed rules 保留。
2. numbered REST next 從 page=1 跳至 page=3 可漏 page=2，卻回報 complete。最小修正要求 next=page+1；异常停止完整性推論，仍保留已看到項目。

[原 HEAD 的反例觀測](attachments/pr14-additional-counterexamples-before.json)。PR15 的新增三個 unittest methods 先在舊 implementation 重現紅測試，再修正；[公開新 HEAD 測試 receipt](attachments/pr15-published-head-validation.json) 綁真實版本與 UTC，63 tests／0 fail／0 skip／exit 0。原 PR14 不被推動；這不是重新實作 collector。

新 PR15 exact-head 普通 push CI `34318984895` success；trusted `34319029966` success。它們與 Python 63/63、collector 正式審查均分開，不互相替代。

## 封包是否受新缺陷影響

實際既有封包的 HTTP-200 classic body `0022` 有明確 boolean `enforce_admins.enabled=true`；67-request 中 REST 分頁均在 page 1 終結，没有跳頁。故兩個反例不出現在這份已保存資料，這份 snapshot 的正向規則／身分／permission 觀測可保留。這不是用新工具重跑舊 acquisition，也不是宣稱所有未測的 API 形狀都已正確。

原工具仍保留明示限制：allowances 超過 20 未完成、複雜 wildcard／未知 rule parameter schema、org/fork scope 未建立時保持 UNKNOWN；順序讀取不是原子 snapshot。collector completeness 與 owner adoption 是不同結論。Snapshot 顯示的 strict 政策差異見 [PR11 prerequisites](PR11-ADOPTION.md)，不能因 sources 完整而忽略。
