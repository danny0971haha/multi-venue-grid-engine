# PR11 — owner adoption prerequisites（READ-ONLY）

狀態：`ADOPTION=NOT_PERFORMED`。本輪核對 PR11 head=`de2f5c0fd055e418d0b6d806f994b52baa743544`，tree=`1b443a620670216968b95cc43de96397550c24f2`；base main=`22665d7fa9274dfc05de043c8e9663e24e75087e`，tree=`6981c1124524895273fb09b53d769ca9dbb722bc`。PR 仍 Draft／open／not merged，reviews API 為空。沒有把先前的 evidence publication 或本輪報告當成採用證據。

## 工作流變更的實際範圍

對 actual base/head 的 diff 確認：trusted workflow 新增一行 `branches: [main]`；baseline 只更新該 governance workflow 的 blob/SHA256 inventory；第三個檔案是說明。不是 runtime baseline rebind；jobs、permissions、event types、Action pins、classifier、保護檔案與候選語义不變。本轮只讀取。

main-target／fork-head targeting main 仍觸發；non-main base 不觸發；retarget 到 main 的 edited event 會重新適用。沒有為 non-main 製造綠色 required context。PR13 當次 base 沒有 classifier 所造成的 failure 已由原 job log 核實；PR11 尚未進 main，故不能當作該 failure 已修復。

Exact-head CI 可見 ordinary `33965123844`／`33965120390` success、governance self-test `33965123861` success、trusted `33965121413`／`33965203305` success。[metadata](attachments/pr11-exact-head-runs.body) 是 CI observation，不是正式審查或 owner adoption。

## 合併有效保護：不能只看 ruleset

下表只適用於 PR14 acquisition 的 `2026-09-08 17:37:48–17:38:25 UTC` snapshot。來源是已驗 hash 的 raw `0021` GraphQL classic patterns、`0022` REST main protection，以及 `0020` ruleset detail；完整 raw/sources 在 PR14 原 archive。採用前必須重新確認，這輪未重跑 protection acquisition。

| 要求 | active ruleset 21580900 | classic main protection | 合併有效解讀 |
|---|---|---|---|
| 範圍 | `refs/heads/main`，exclude=[] | pattern=`main` | main；此 snapshot 無 non-main expected-context requirement |
| required contexts | `trusted-phase2d-freeze-gate` + `Clean install, static checks, tests, secret scan, and dry-run` | 同兩項 | 兩項都必須满足 |
| app/integration | 兩者 `integration_id=15368` | 兩者 `app_id/databaseId=15368`，GitHub Actions | context 字串與 app 身分一起核對；同名他 app 不能直接替代 |
| strict/up-to-date | false | **true**（REST strict=true；GraphQL requiresStrictStatusChecks=true） | **true**；不是 ruleset 的 false |
| approving reviews | 0 | 0 | 沒有 countable approval 數量門檻，不等於已完成專案獨立審查 |
| Code Owner／last push approval | false／false | false／false | 未強制這兩項 |
| conversation resolution | true | true | 必須解決討論 |
| force push／deletion | 禁止／禁止 | false／false | 禁止 |
| bypass／admin | bypass_actors=[]；current_user_can_bypass=never | isAdminEnforced=true；四種 actor allowance connection 皆空且完整 | 該 snapshot 未觀測 bypass allowance；不是未來無 bypass 保證 |
| merge method／直接 main push | PR rule；allowed_merge_methods=[merge] | review protection 啟用但 count=0 | ruleset 要求 PR 路徑與 merge commit；不授權本輪自行 merge |

GitHub 官方說明 [rulesets 與 classic protection 共同生效並採更嚴格規則](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)。因此 strict=true 是由原始觀測與官方合併規則推出的結論。

**具體 owner 決策缺口：** `main` 的 repository-governance-policy.json 與 TRUSTED_PHASE2D_REVIEW_BOUNDARY.md 明定 SOLO_OWNER_BOOTSTRAP 的 strict=false，且指出 frozen Phase2 source 未整合前不能要求推動其 HEAD 成為 up-to-date；但本 snapshot 合併要求是 strict=true。這是「觀測完整但治理政策不符」，不能寫成 owner 前提已全滿足。需 owner 在採用前確認現況、解決政策與設定衝突並留下正式授權紀錄。本輪不改 strict、不更新 frozen source、不改 baseline pin。

org/enterprise NOT_APPLICABLE 的依據是該 snapshot 的 repository full name、User owner、fork=false、before/after 身分、official applicability 及沒有相反 inherited source；不是 org endpoint 404。權限依 repo permissions.admin before/after 與 GraphQL viewerPermission=ADMIN；endpoint-required headers 不構成 caller administration。

## 採用顺序與獨立 reviewer

1. 先由具獨立身分的 reviewer 針對 exact PR11 head/base/tree、工作流適用性與 inventory 差異作正式審查；同时审视上述 strict 差異及有效 required context/app/bypass。不要以此 self-check 或同 owner 另一帳號充當獨立 reviewer。
2. Owner 在接近採用的時間重新確認完整 classic pattern／ruleset／inherited scope／effective rules／permissions／actor allowances、實際 refs 與所有 required context/app 綁定，並處理 strict 政策差異。旧 snapshot 不是 current settings 保證。
3. 若 owner 另行明確授權治理採用，由治理審查結果決定 PR11 merge-commit 順序與後续主分支證據。這輪不執行。main 變更後，其他 governance 候選的 base 與 inventory／合成整合測試需重新對帳，不能直接沿用舊 base 結論。
4. PR8 是另一个 governance 候選：需獨立審查後才可能成為 main 的可信 runtime gate。PR7 runtime 必須以 exact `704afa2…` 獨立驗收；既有 frozen-bootstrap 次序也須由 owner 對實際 refs 和已整合紀錄確認。這不是指令重做歷史 PR1/PR2/PR4。
5. 任何後續新 candidate pin，都須新的 exact-SHA review 與單獨治理授權；不能因 PR13/15 工具測試通過便自動 rebind。

專案既有 active profile 是降低保障的 SOLO_OWNER_BOOTSTRAP，GitHub 0 approvals 不提供人員職責分離。STRICT_MULTI_REVIEWER 的未啟用前提是至少兩位真正 eligible independent collaborators；同一 owner 控制的兩個帳號不算，不能使用 placeholder。正式 reviewer 回應須按 EVIDENCE_TEMPLATE.md 綁 repository、branch、base、result SHA／patch hash、gate、decision、findings 及 next authorized state。本輪沒有該 principal 的正式 verdict。
