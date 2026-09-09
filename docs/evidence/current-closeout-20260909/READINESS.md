# Trading engine READINESS — 實際能力與下一個最小工作包

目前允許的範圍是**既有候選的假資料／離線工程驗證與證據審閱**。Repo 確有 domain／grid／simulator、durable persistence／lease／risk、halt／ACK，以及既有 offline integration harness；尚不等於完整 dry-run engine，更不等於可部署或實盤。

盤點以本輪觀測的 19 個遠端 branch heads 的 tracked `src/`、`test/` 與 venue-audit 路徑為邊界，逐 branch 建 [inventory](attachments/all-remote-capability-inventory.json)，再實讀 runtime／integration 實作及 CURRENT_STATUS、ACCEPTANCE_GATES、IMPLEMENTATION_CONTRACT、RISK_PERSISTENCE_CONTRACT、VENUE_ADAPTER_CONTRACT、相關證據與治理文件。沒有從某個 PR 的範圍推論整個 repo 無能力。未發布的其他電腦、未追蹤草稿及外部交付不在此 inventory，不能據此聲稱不存在。

## 候選身分

| 代號（下表每列引用） | HEAD | tree | 範圍 |
|---|---|---|---|
| M | `22665d7fa9274dfc05de043c8e9663e24e75087e` | `6981c1124524895273fb09b53d769ca9dbb722bc` | 現行 main；bootstrap 與已整合治理，不是所有 runtime 候選已整合 |
| S1 | `057732cee021889d17573425ee4f24e2065df1e9` | `e4abb554c74635b0eeb09ea8b3255f62abbb42d9` | 歷史 Phase1 domain/simulator 候選；歷史文件記錄 Gate1 PASS，不在此重新頒發 |
| F | `7f196d367e39640eee9517f742b0d61424f9d4cc` | `1b0afe805269972cf7af40f7fbf0e4e6b3e35894` | frozen Phase2D candidate |
| R | `704afa2dd858c52dad06aa22941d463aa5ce4d69` | `bda9793acd2fb8de033f65739b8c092cbdec7d9b` | PR7 runtime Corrective3；base=F |
| T | `d85478a7e1edbf85fa95f7ad3091ad1561a8d61d` | `e3ce65b47ff9659132cb7211ecb5dcc8510ae152` | PR13 tooling/integration descendant；base=`4ead284…`，不是治理 runtime pin |
| G | `52445f4c2b3eb65f13ae00dbef80f07b417a7d53` | `13ed781c547cfa34a397565f6b78c9f94c31c903` | PR8 governance candidate；base=M |

## 實際能力表

檔案連結固定到實際候選 commit，不是 main 的可變路徑。測試欄標明本輪核對 CI 或既有交付，沒有把合同需求當成已實作。

| 功能 | 實作檔案 | 測試／CI | 精確候選身分 | 正式審查結果 | 現在可用範圍 | 尚缺工作 |
|---|---|---|---|---|---|---|
| offline simulator、decimal、grid geometry／意圖、fill／duplicate／ownership／snapshot | [simulator/engine.ts](https://github.com/danny0971haha/multi-venue-grid-engine/blob/704afa2dd858c52dad06aa22941d463aa5ce4d69/src/simulator/engine.ts)、snapshot.ts；domain/ownership.ts；math/decimal.ts；strategy/geometry.ts、levelState.ts | test/simulator/*、math/domain/strategy；T 的 run34205089339：474 suite 全通過；另 T integration 13/13 | S1→F→R；本輪 CI checkout=T；不可把 T 改稱 R | 歷史 Gate1 PASS 有文件記錄；本輪不重新驗收該歷史判定；R/T 無全面接受 | deterministic fixture、simulated ACK/UNKNOWN、execution replay、snapshot roundtrip | production coordinator 的 durable intent/cursor／serialized sends／restart gate，不只是 simulator 方法 |
| durable envelope／exact-pair／atomic persistence | [atomic-pair-store.ts](https://github.com/danny0971haha/multi-venue-grid-engine/blob/704afa2dd858c52dad06aa22941d463aa5ce4d69/src/persistence/atomic-pair-store.ts)、durable-envelope.ts、exact-pair-inspection.ts、runtime-persistence-latch.ts | test/persistence/*，real child crash fixtures；既有 phase2B evidence；T 474 suite 包含既有回歸 | F/R；src bytes 在 T 相同 | 歷史 phase2A/B bounded review 有記錄；不代表 Gate2 overall 完成 | 假資料 durable store、exact-pair reload、uncertainty latch | 與完整 runtime lifecycle、telemetry failure、restart reconciliation 的正式整合驗收 |
| host-local lease／fencing | [runtime-lease.ts](https://github.com/danny0971haha/multi-venue-grid-engine/blob/704afa2dd858c52dad06aa22941d463aa5ce4d69/src/persistence/runtime-lease.ts)、lease-coordination.ts、lease-witness.ts、coordination-claim.ts | runtime-lease*.test.ts／process crash fixtures；T 474 suite | F/R；T 同 bytes | 歷史 Phase2C Corrective2 有 bounded acceptance 記錄；全系統未授權 | 單主機 scope owner、generation／lease-gated fake mutation | 不宣稱跨 host/distributed lease；production 每次 send 的一致 fencing 與重啟全鏈路驗收 |
| risk／halt／kill switch／durable ACK／process fence | [risk-engine.ts](https://github.com/danny0971haha/multi-venue-grid-engine/blob/704afa2dd858c52dad06aa22941d463aa5ce4d69/src/risk/risk-engine.ts)、[halt/engine.ts](https://github.com/danny0971haha/multi-venue-grid-engine/blob/704afa2dd858c52dad06aa22941d463aa5ce4d69/src/halt/engine.ts)、halt/store.ts、record.ts、halt-id.ts、transport.ts | risk tests 在474；halt dedicated79；既有 halt32/ACK16 crash window evidence；本輪 T CI474/79、native integration13 | risk=F/R；halt=R；本輪 T CI 不替代 R 審查 | Phase2E Corrective3=REVIEW_CANDIDATE／NOT_PERFORMED；Gate2未建立 | 呼叫既有 API 的 fake transport／合成 authoritative snapshot；halt/ACK工程驗證 | R 正式獨立審查；production fatal handler/supervisor 及 telemetry/restart 線路仍需完整驗收；沒有真實 exchange reduction 能力 |
| execution coordinator／reconciliation | 現有基礎在 simulator/engine.ts、domain/ownership.ts；[test/offline-integration/scenarios.ts](https://github.com/danny0971haha/multi-venue-grid-engine/blob/d85478a7e1edbf85fa95f7ad3091ad1561a8d61d/test/offline-integration/scenarios.ts) 是測試 wiring；已盤點 src 無獨立 production execution coordinator | simulator reconcile/duplicate/UNKNOWN 測試與 T13 fake integration；沒有 Gate3 full matrix acceptance | R 基礎；T harness；正式 Gate3 candidate 未交付於所盤點 published heads | Gate3=未建立正式審查結果 | 模擬訂單／execution／restart reconciliation 與 harness-local dedup | durable unresolved intent registry、whole-batch reserve、conflict serialization、cursor overlap/gap／reconnect、每次 simulated send lease check，P3全部驗收 |
| first venue read-only adapter | published inventory 無 venue adapter implementation／dated venue-audits；VENUE_ADAPTER_CONTRACT.md 只有介面要求，src/halt/transport.ts 是 scripted fake | 未見 conformance candidate/tests；GitHub collector 不是交易所 adapter | 所盤點 M/F/R/T 等19 refs；Gate4A候選未建立 | Gate4A=未建立 | 此輪只有 synthetic fixtures；不連交易所 | 選一 venue、官方能力稽核、symbol/tick/step、account/position/order/execution/freshness 映射、真實 fill provenance；private只讀輸入需另授權 |
| second venue abstraction proof | published inventory 無第二 adapter／shared adapter conformance implementation | 未見 Gate4B conformance evidence | 所盤點 published refs；第二候選未建立 | Gate4B=未建立 | 無真實第二 venue 使用範圍 | 第一 adapter 接受後，第二官方稽核、shared contract conformance、明示差異，不能以 venue-name strategy 分支掩蓋差異 |
| integrated dry-run／fault campaign | T [offline-candidate.py](https://github.com/danny0971haha/multi-venue-grid-engine/blob/d85478a7e1edbf85fa95f7ad3091ad1561a8d61d/scripts/offline-candidate.py)、test/offline-integration/*；[src/index.ts](https://github.com/danny0971haha/multi-venue-grid-engine/blob/704afa2dd858c52dad06aa22941d463aa5ce4d69/src/index.ts) 仍只呼叫 bootDryRun | T指定run native13/13、fresh child reload；原 kernel-isolated wrapper 報告與CI留存；不是新完整campaign | T=`d85478a…`；測試 wiring 不屬 R runtime pin | offline harness 無全面正式接受；Gate5未建立 | 現有 Linux/Python/libseccomp/pinned deps 下的 fake-only harness；`npm run dry-run` 僅 bootstrap | Phase2F telemetry/manifest；Gate3 coordinator；read normalization；完整 TEST_FAULT_MATRIX、integrated crash/restart、append-only可重建事件與commit manifest |
| live contract／deployment readiness | runtimeMode.ts 明確拒絕 LIVE；沒有 published production signer／exchange mutation adapter／live deployment runtime；contracts只描述未來要求 | bootstrap LIVE rejection；沒有 commit-bound live-canary acceptance 或部署驗收 | M/F/R/T 都不能構成 live candidate | LIVE／DEPLOYMENT=未授權；live gate未定義完成 | 離線研究／工程自查 | separate commit-bound live contract、雙 opt-in/ack、authoritative metrics/fills、實際 cancel/reduce/flatten/fresh verify、operational runbook與獨立review及人類授權 |

## 目前允許如何使用

可審閱／重跑已存在、與明確候選綁定的 fake-only simulator／工具測試。T 的 offline wrapper 需要 Linux、Python3、libseccomp.so.2、Node22.23.2/npm10.9.8、可信本地 dependency cache 與無交易憑證的 checkout；缺依賴或 isolation 不可用應 fail closed，不能改成網路 fallback。這一輪只對帳既有 Linux CI，沒有在本機 macOS 冒充 Linux isolation。

`npm run dry-run` 的 bootstrap JSON 不是交易迴圈；fake harness 的 13/13 不是完整 Gate5；scripted flatten/reduce 的 ACK 不是 exchange 真實平倉。既有 durable/lease/halt 能力則確已存在，不需重新實作。PR13 retention 和 PR14/15 collector 是工程／審查工具，不能當作新增交易能力。

## 缺口分類

| 類別 | 具體事項 | 本輪處置／後續責任 |
|---|---|---|
| 工程缺陷（已重現） | 原 PR14 缺少 enforce_admins boolean 驗證；REST skipped page 可誤判完整 | Draft PR15最小修正、公開head63/63；待 reviewer，原PR14不覆寫。PR13未重現新缺陷。 |
| 證據缺口 | 歷史33967073453原native log缺失；current independent review records不足 | 歷史保持NOT_OBTAINED；新PR13 receipt已補齊，不拿新檔冒充舊檔。 |
| Owner／治理決策 | PR11/PR8採用順序、effective strict=true與bootstrap false差異、獨立reviewer principal、base變動後再綁證據 | READ-ONLY報告；owner／reviewer另決，不改設定或refs。 |
| 外部／環境輸入 | 未來venue官方capability facts、可驗證fills／時間／rules、如需private只讀則另授權的credentials與scope；離線cache／Linux隔離環境 | 本輪不讀憑證、不查交易所、不建立假數值；尚未取得的不標為已驗證。 |
| 尚未完成能力 | Phase2F append-only telemetry/manifest與integrated restart；production Gate3 coordinator；first/second read adapters；Gate5全fault campaign；live contract／部署運維 | 依原phase順序形成未來工作包；不全部混稱同一BLOCKED，也不在此開始。 |
| 正式審查待辦 | R runtime、G governance、原PR13候選重新資格及PR15collector新候選 | 實作者自查不提供formal verdict；各候選獨立decision與exact identity。 |

## 下一個最小 runtime 工作包（僅提案，本輪 NOT_STARTED）

建議先完成 R 的正式獨立審查及 owner 對下一階段的明確授權；不要先改 R/frozen refs。隨後可界定 **Phase2F 第一個 checkpoint：durable manifest＋append-only safety event sink 的 fail-closed authority 接線**。

提案基線必須是當時被正式接受的 exact R descendant SHA/tree，不能直接把本輪工具分支當 runtime base。候選 writable scope 僅新的 telemetry/manifest 模組、最少 runtime 接線與其測試／證據；不得同包新增 coordinator、venue、策略或治理 workflow。保留100U/5x/30U/150U/10 levels/±3% envelope，manifest 綁 commit、config、schema、run/scope；重要 transition 具有單調序號及可追溯 identity；事件／manifest 持久化失敗不得授權 risk increase。

必要驗收是：write/fsync/partial-tail/corruption/duplicate/replay 反例；fresh process restart 能讀回 manifest 並重建安全轉移，不自动 ACK；接點處程序中止後只允許已證明舊狀態、新狀態或 fail-closed；既有474/79回歸保持且新增suite獨立計數。第一 checkpoint 不宣稱完整 Gate2/5；由 reviewer 判斷能否進下一個 integrated restart checkpoint。

完整 dry-run 還需走完 Phase2F→Gate2正式審查→Gate3 coordinator→Gate4A/4B（或reviewer明定單venue範圍）→Gate5完整fault campaign。之後實盤仍另外需要已審的commit-bound live契約、真實venue能力、operational/部署驗收及明確人類授權，不能從綠色CI自動升級。

本輪未開始上述 runtime 工作包、未 merge、未部署、未讀交易所憑證、未連交易所、未做 testnet/mainnet write。
