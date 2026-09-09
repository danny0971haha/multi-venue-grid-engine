# PR7 runtime／PR8 governance — 正式審查與授權狀態

本輪結論：`FORMAL_CURRENT_CANDIDATE_REVIEW=NOT_ESTABLISHED`；現有交付文件寫明 `NOT_PERFORMED`，GitHub reviews API 亦無紀錄。不能把 PR13 的新 receipt、PR14/15 collector 測試或 CI success 轉成這兩個候選的正式獨立接受。

| 對象 | 精確身分 | 已有實作／證據 | 正式狀態與界線 |
|---|---|---|---|
| PR7 runtime | HEAD `704afa2dd858c52dad06aa22941d463aa5ce4d69`；tree `bda9793acd2fb8de033f65739b8c092cbdec7d9b`；base `7f196d367e39640eee9517f742b0d61424f9d4cc`／tree `1b0afe805269972cf7af40f7fbf0e4e6b3e35894` | halt engine、durable ACK、process fence、halt/ACK crash matrices；Corrective3 共用 current-running authorization；ordinary CI `33379688278`／`33379692292` success，trusted `33379689771` failure | Draft/open/not merged；reviews=[]；現有 PHASE_2E_EVIDENCE.md 仍是 review candidate。沒有 Phase2E／Gate2／merge／live 授權。 |
| PR8 governance | HEAD `52445f4c2b3eb65f13ae00dbef80f07b417a7d53`；tree `13ed781c547cfa34a397565f6b78c9f94c31c903`；base main `22665d7fa9274dfc05de043c8e9663e24e75087e`／tree `6981c1124524895273fb09b53d769ca9dbb722bc` | live candidate baseline `.github/trusted/phase2e-corrective3-baseline.json` 已綁 PR7 上述 SHA/tree；151 governance tests 是既有交付自查；ordinary CI `33465804096`／`33465804410`、governance self-test `33465804430`、trusted `33465802424` success | Draft/open/not merged；reviews=[]；main 尚未採用此 gate；沒有正式治理接受／merge／部署授權。 |

[PR7 actual metadata](attachments/pr7-metadata.body)、[PR7 reviews](attachments/pr7-reviews.body)、[PR8 actual metadata](attachments/pr8-metadata.body)、[PR8 reviews](attachments/pr8-reviews.body)，及各 exact-head CI list 皆在附件。本輪只核對已存在 CI metadata；未將 PR7 historical trusted failure 當成新重跑结果，也未重跑 runtime suite。

較早 PR7 body 的 24 tests 或手冊中的較早 status 日期，不能當成現在套件總數；後續 Corrective3 與 [CURRENT_STATUS / VALIDATION_GUIDE](https://github.com/danny0971haha/multi-venue-grid-engine/blob/d85478a7e1edbf85fa95f7ad3091ad1561a8d61d/docs/VALIDATION_GUIDE.md) 區分 frozen 474 與 halt 79。PR13 指定 CI 的 actual job log 已核對 474/79，而 PR13 與 PR7 的 `src/`、`test/halt/`、`test/persistence/`、`test/risk/` 差異為空；這是 code continuity 證據，仍不將 PR13 CI 身分改成 PR7。

較早 PHASE_2E_EVIDENCE.md 的「PR8 rebind required」已被後來 PR8 Corrective3 baseline 實際 bytes 解決，現在剩的是該治理候選的正式審查和 owner 採用，不能重做已交付 pin，也不能稱已採用。舊 Corrective1 pin 已失效；只有 PR8 已明列的 Corrective3 pin 是該候選的 current baseline。

歷史 ACCEPTANCE_GATES.md 與 IMPLEMENTATION_CONTRACT.md 記錄不同日期／範圍的 Gate0/Gate1、Phase2A/B/C 及 risk corrective 決定。CURRENT_STATUS 已要求它們不能套用成 Phase2D overall／Phase2E／Gate2 全面接受。本報告保留這些歷史記錄，不重新頒發或推翻其歷史 verdict，也不把未找到 current review 說成 repo 完全沒有既有實作。

正式下一步是由獨立 reviewer principal 分別審 PR7 與 PR8 exact candidates，綁明 base/tree、證據、findings 與後續許可狀態。相同 owner 其他帳號、實作者自查、AI summary 或本報告不構成獨立 principal。Owner 採用 governance 的順序、當時 effective protections、任何 base 改變後的整合驗證另作決策。不得自動推動 frozen/runtime refs 以消除 strict/up-to-date 衝突。

```text
PR7_FORMAL_ACCEPTANCE=NOT_ESTABLISHED
PR8_FORMAL_ACCEPTANCE=NOT_ESTABLISHED
PR7_MERGE_AUTHORIZED=NO
PR8_MERGE_AUTHORIZED=NO
PHASE_2E_AUTHORIZED=NO
GATE_2_ACCEPTED=NOT_ESTABLISHED
DEPLOYMENT_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
```
