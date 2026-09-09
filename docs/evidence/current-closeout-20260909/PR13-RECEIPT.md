# PR13 — current-head receipt

結論：本輪已完成指定 current-head 的下載後證據對帳，沒有重現留存工具缺陷。這是機械驗證完成，不是正式獨立接受、merge 或 Gate 2 結論。

## 新舊身分

| 意義／schema | SHA / tree / run |
|---|---|
| PR13 source baseline（retention manifest `sourceHead/sourceTree`） | `4ead28400903ad6c62616835aa9459f67c6d8cd9` / `3a10f7645b30a33f27ecde824c16e0e36cacae6c` |
| 舊 handoff 的 actual tested checkout | `82105054f9aac595e767e5203d3e581ec3c10126` / `fbeb1194203ad280587070416e2461114b1bcfb4`；run `34203992314` |
| 本輪指定 PR head 與 actual tested checkout | `d85478a7e1edbf85fa95f7ad3091ad1561a8d61d` / `e3ce65b47ff9659132cb7211ecb5dcc8510ae152` |
| 普通 CI | `34205089339`，push，attempt 1，success；job key `verify`，API job database ID `101992604185` |
| trusted gate | `34205091382`，pull_request_target，attempt 1，failure；job `101992611101` |
| 歷史 run | `33967073453`，native `01.log` 仍 `NOT_OBTAINED` |
| 此 receipt publication | 新 evidence-only commit，見 PR comment 索引；不是以上 tested checkout |

讀過 PR13 當前 body／comments、既有 `docs/evidence/ci-native-log-retention-20260908/` handoff/status/download-verification、同 repo 既有 artifacts 與 PR14 記錄；未找到 `34205089339` 的既有下載後 receipt，才下載其兩個 artifacts。舊 receipt 驗證的是 `82105054…`，不改写成 `d85478a…`。

## 下載後驗證

下載時間 2026-09-09 06:16:14–06:16:17 UTC；原 run 2026-09-08 08:32:55–08:35:52 UTC。metadata/jobs/artifacts/logs 的 GET 均 exit 0，命令與 UTC 在 [verification-commands](attachments/verification-commands.json)。

| artifact | GitHub digest 與實際 ZIP SHA256 | 核對 |
|---|---|---|
| `10047503719` native retention | `303237974a570fcd72d48ca2948f53eef296bed5701ca1681287a46c5d06e0e4` | ZIP digest 相符；6 條 SHA256SUMS 全相符；manifest 5 檔 bytes/hash 全相符 |
| `10047503229` Phase2D v2 | `c7f0e16060ecc17ff9aac6245cb613704b8fd7c025eee81ed2ba7af2562226da` | ZIP digest 相符；逐檔 SHA256 已列 receipt；10 commands 的 20 stdout/stderr hashes、source commitments、test inventory 均對 actual checkout |

[機械 receipt](attachments/pr13-current-head-receipt.json) 列出解壓後每一檔 SHA256；[原 native ZIP](attachments/artifact-10047503719.zip) 與 [原 v2 ZIP](attachments/artifact-10047503229.zip) 可供再次解壓。沒有重新產生或修改 manifest。

Native `native/artifacts/offline-candidate/test/01.log`：2420 bytes，SHA256=`d56ca029b7fb003bc0ec4e20fd5032e46b689a97150e783512c5bf17c2fd0629`；從原 log 解析 TAP：tests=13、pass=13，fail/cancelled/skipped/todo 全 0。wrapper stdout 1148 bytes，SHA256=`43261b5747ab92051577156a0e3f7d2084c4afd3903f87cf90bf36421dbc1393`；stderr 98 bytes，SHA256=`2890c4e48fd963e0bf449f7bb16f3319f985c21b83e93daa43b377a4388ba5fe`。wrapper 所報 native hash 與原檔一致。

capture-result 與 manifest：exitCode=0、signal=null，實際 command=`npm run test:offline-integration`；開始 `2026-09-08T08:33:46.316Z`、結束 `2026-09-08T08:33:47.974Z`。這些值來自 capture wait，不是從 GitHub success 推導。packet ID=`run-34205089339-attempt-1-job-verify`。manifest 的 `jobDatabaseId=UNKNOWN` 保留原狀；API metadata 補充 `101992604185`，不倒填原 manifest。

以公開 PR13 bytes 的 `verify.mjs`，明確綁 `EXPECTED_RUN_ID`、`EXPECTED_TESTED_SHA`、`CI_NATIVE_LOG_PACKET_ID`，exit 0／ok=true／errors=[]；[輸出](attachments/pr13-downloaded-verify.json)。留存工具 12 個測試已在 CI 與本輪 Node22.23.2 執行通過，與 474/79/13 等 suite 不合併計數。

Phase2D `/2` schema 中 `sourceHeadSha` 在 push 是當次 PR13 source head；`baseSha=057732c…` 和 `implementationBaseSha=c64fa29…` 是既有 schema 的來源／實作 baseline，並非 PR13 的 PR base。該 manifest source/tested 同為 `d85478a…` 正確；retention schema 的 `sourceHead=4ead284…` 也正確。兩套欄位語義不同，沒有為一致外觀改原始欄位。v2 verifier 原 CI 是 integrityOk=true、independentReview=NOT_PERFORMED、gateStatus=NOT_EMITTED；本輪核對下載 bytes，不重執行會重寫 verifier.json 的整套 runtime verifier。

## 普通 CI 與 trusted failure

普通 CI 原 job log 可讀出 pinned Node/npm、留存 12/12、既有總 suite 474/474、halt 79/79；native integration 是獨立 13/13。CI success 不授權任一 runtime／治理 gate。

Trusted 原 job log 在 `08:33:01.505Z` 指定 checkout `4ead284…`，後續 checkout log 與 HEAD 確認一致；在 `08:33:03.131Z` 執行 `node scripts/governance/phase2d-trusted-gate.mjs` 發生 `MODULE_NOT_FOUND`、exit 1。對該 base Git tree 亦核實 classifier 不存在。這是目前 main workflow 對 stacked/non-main base 的適用性缺陷；PR11 尚未採用，所以其 main-only filter 不會修正這次歷史執行。不改 workflow、不取消 required check，也不偽造成功。

## 結案邊界

新留存工具與新指定候選的 receipt 已可送正式重新資格審查。歷史原件缺失仍是歷史證據缺口，不能由新 log 冒充；也不把它擴張成任何新候選永遠不能再審的理由。新候選若要取得治理 pin 或 runtime 接受，須另經 exact SHA/tree 的獨立審查與 owner 決策，本輪不執行。
